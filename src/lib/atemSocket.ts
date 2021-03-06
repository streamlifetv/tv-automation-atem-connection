import { createSocket, Socket } from 'dgram'
import { EventEmitter } from 'events'
import { Util } from './atemUtil'
import { CommandParser } from './atemCommandParser'
import { ConnectionState, PacketFlag } from '../enums'
import AbstractCommand from '../commands/AbstractCommand'

export class AtemSocket extends EventEmitter {
	private _connectionState = ConnectionState.Closed
	private _debug = false
	private _reconnectTimer: NodeJS.Timer | undefined
	private _retransmitTimer: NodeJS.Timer | undefined

	private _localPacketId = 1
	private _maxPacketID = (1 << 15) - 1 // Atem expects 15 not 16 bits before wrapping
	private _sessionId: number

	private _address: string
	private _port: number = 9910
	private _socket: Socket
	private _reconnectInterval = 5000

	private _inFlightTimeout = 200
	private _maxRetries = 5
	private _lastReceivedAt: number = Date.now()
	private _inFlight: Array<{packetId: number, lastSent: number, packet: Buffer, resent: number}> = []

	private _commandParser: CommandParser = new CommandParser()

	constructor (options: { address?: string, port?: number, debug?: boolean, log?: (args1: any, args2?: any, args3?: any) => void }) {
		super()
		this._address = options.address || this._address
		this._port = options.port || this._port
		this._debug = options.debug || false
		this.log = options.log || this.log

		this._createSocket()
	}

	public connect (address?: string, port?: number) {
		if (!this._reconnectTimer) {
			this._reconnectTimer = setInterval(() => {
				if (this._lastReceivedAt + this._reconnectInterval > Date.now()) return
				if (this._connectionState === ConnectionState.Established) {
					this._connectionState = ConnectionState.Closed
					this.emit('disconnect', null, null)
				}
				this._localPacketId = 1
				this._sessionId = 0
				this.log('reconnect')
				if (this._address && this._port) {
					this._sendPacket(Util.COMMAND_CONNECT_HELLO)
					this._connectionState = ConnectionState.SynSent
				}
			}, this._reconnectInterval)
		}
		if (!this._retransmitTimer) {
			this._retransmitTimer = setInterval(() => this._checkForRetransmit(), 50)
		}

		if (address) {
			this._address = address
		}
		if (port) {
			this._port = port
		}

		this._sendPacket(Util.COMMAND_CONNECT_HELLO)
		this._connectionState = ConnectionState.SynSent
	}

	public disconnect () {
		return new Promise((resolve) => {
			if (this._connectionState === ConnectionState.Established) {
				this._socket.close(() => {
					clearInterval(this._retransmitTimer as NodeJS.Timer)
					clearInterval(this._reconnectTimer as NodeJS.Timer)
					this._retransmitTimer = undefined
					this._reconnectTimer = undefined

					this._connectionState = ConnectionState.Closed
					this._createSocket()
					this.emit('disconnect')

					resolve()
				})
			} else {
				resolve()
			}
		})
	}

	public log (..._args: any[]): void {
		// Will be re-assigned by the top-level ATEM class.
	}

	get nextPacketId (): number {
		return this._localPacketId
	}

	public _sendCommand (command: AbstractCommand) {
		if (typeof command.serialize !== 'function') {
			return
		}

		const payload = command.serialize()
		if (this._debug) this.log('PAYLOAD', payload)
		const buffer = new Buffer(16 + payload.length)
		buffer.fill(0)

		buffer[0] = (16 + payload.length) / 256 | 0x08
		buffer[1] = (16 + payload.length) % 256
		buffer[2] = this._sessionId >> 8
		buffer[3] = this._sessionId & 0xff
		buffer[10] = this._localPacketId / 256
		buffer[11] = this._localPacketId % 256
		buffer[12] = (4 + payload.length) / 256
		buffer[13] = (4 + payload.length) % 256

		payload.copy(buffer, 16)
		this._sendPacket(buffer)

		this._inFlight.push({ packetId: this._localPacketId, lastSent: Date.now(), packet: buffer, resent: 0 })
		this._localPacketId++
		if (this._maxPacketID < this._localPacketId) this._localPacketId = 0
	}

	private _createSocket () {
		this._socket = createSocket('udp4')
		this._socket.bind(1024 + Math.floor(Math.random() * 64511))
		this._socket.on('message', (packet, rinfo) => this._receivePacket(packet, rinfo))
		this._socket.on('close', () => this.emit('disconnect'))
	}

	private _receivePacket (packet: Buffer, rinfo: any) {
		if (this._debug) this.log('RECV ', packet)
		this._lastReceivedAt = Date.now()
		const length = ((packet[0] & 0x07) << 8) | packet[1]
		if (length !== rinfo.size) return

		const flags = packet[0] >> 3
		// this._sessionId = [packet[2], packet[3]]
		this._sessionId = packet[2] << 8 | packet[3]
		const remotePacketId = packet[10] << 8 | packet[11]

		// Send hello answer packet when receive connect flags
		if (flags & PacketFlag.Connect && !(flags & PacketFlag.Repeat)) {
			this._sendPacket(Util.COMMAND_CONNECT_HELLO_ANSWER)
		}

		// Parse commands, Emit 'stateChanged' event after parse
		if (flags & PacketFlag.AckRequest && length > 12) {
			this._parseCommand(packet.slice(12), remotePacketId)
		}

		// Send ping packet, Emit 'connect' event after receive all stats
		if (flags & PacketFlag.AckRequest && length === 12 && this._connectionState === ConnectionState.SynSent) {
			this._connectionState = ConnectionState.Established
		}

		// Send ack packet (called by answer packet in Skaarhoj)
		if (flags & PacketFlag.AckRequest && this._connectionState === ConnectionState.Established) {
			this._sendAck(remotePacketId)
			this.emit('ping')
		}

		// Device ack'ed our command
		if (flags & PacketFlag.AckReply && this._connectionState === ConnectionState.Established) {
			const ackPacketId = packet[4] << 8 | packet[5]
			for (const i in this._inFlight) {
				if (ackPacketId >= this._inFlight[i].packetId) {
					this.emit('commandAcknowleged', this._inFlight[i].packetId)
					delete this._inFlight[i]
				}
			}
		}
	}

	private _parseCommand (buffer: Buffer, packetId?: number) {
		const length = buffer.readUInt16BE(0)
		const name = buffer.toString('ascii', 4, 8)

		if (name === 'InCm') {
			this.emit('connect')
		}

		// this.log('COMMAND', `${name}(${length})`, buffer.slice(0, length))
		const cmd = this._commandParser.commandFromRawName(name)
		if (cmd && typeof cmd.deserialize === 'function') {
			try {
				cmd.deserialize(buffer.slice(0, length).slice(8))
				cmd.packetId = packetId || -1
				this.emit('receivedStateChange', cmd)
			} catch (e) {
				this.emit('error', e)
			}
		}

		if (buffer.length > length) {
			this._parseCommand(buffer.slice(length), packetId)
		}
	}

	private _sendPacket (packet: Buffer) {
		if (this._debug) this.log('SEND ', packet)
		this._socket.send(packet, 0, packet.length, this._port, this._address)
	}

	private _sendAck (packetId: number) {
		const buffer = new Buffer(12)
		buffer.fill(0)
		buffer[0] = 0x80
		buffer[1] = 0x0C
		buffer[2] = this._sessionId >> 8
		buffer[3] = this._sessionId & 0xFF
		buffer[4] = packetId >> 8
		buffer[5] = packetId & 0xFF
		buffer[9] = 0x41
		this._sendPacket(buffer)
	}

	private _checkForRetransmit () {
		for (const sentPacket of this._inFlight) {
			if (sentPacket && sentPacket.lastSent + this._inFlightTimeout < Date.now()) {
				if (sentPacket.resent <= this._maxRetries) {
					sentPacket.lastSent = Date.now()
					sentPacket.resent++
					this.log('RESEND: ', sentPacket)
					this._sendPacket(sentPacket.packet)
				} else {
					this._inFlight.splice(this._inFlight.indexOf(sentPacket), 1)
					this.log('TIMED OUT: ', sentPacket.packet)
					// @todo: we should probably break up the connection here.
				}
			}
		}
	}

}
