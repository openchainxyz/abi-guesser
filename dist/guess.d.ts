import { FunctionFragment, ParamType, BytesLike } from 'ethers';
export type HexOrData = BytesLike;
export declare const guessAbiEncodedData: (bytes: HexOrData) => ParamType[] | null;
export declare const guessFragment: (calldata: HexOrData) => FunctionFragment | null;
