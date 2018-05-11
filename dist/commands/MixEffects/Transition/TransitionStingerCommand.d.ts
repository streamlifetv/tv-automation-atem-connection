/// <reference types="node" />
import AbstractCommand from '../../AbstractCommand';
import { AtemState } from '../../../state';
import { StingerTransitionSettings } from '../../../state/video';
export declare class TransitionStingerCommand extends AbstractCommand {
    rawName: string;
    mixEffect: number;
    MaskFlags: {
        source: number;
        preMultipliedKey: number;
        clip: number;
        gain: number;
        invert: number;
        preroll: number;
        clipDuration: number;
        triggerPoint: number;
        mixRate: number;
    };
    properties: StingerTransitionSettings;
    updateProps(newProps: Partial<StingerTransitionSettings>): void;
    deserialize(rawCommand: Buffer): void;
    serialize(): Buffer;
    applyToState(state: AtemState): void;
}