import { ParamType } from '@ethersproject/abi';
import { FunctionFragment } from '@ethersproject/abi/lib';
import { BytesLike } from 'ethers/lib/utils';
type DynamicPlaceholder = {
    offset: number;
    length: number | null;
};
export type DecodedParam = ParamType | DynamicPlaceholder;
export declare const guessAbiEncodedData: (bytes: BytesLike) => ParamType[] | null;
export declare const guessFragment: (calldata: BytesLike) => FunctionFragment | null;
export {};
