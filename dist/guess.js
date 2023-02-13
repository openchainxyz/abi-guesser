"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guessFragment = exports.guessAbiEncodedData = void 0;
const ethers_1 = require("ethers");
const decodeHex = (data) => {
    if (data instanceof Uint8Array)
        return data;
    if (data.startsWith('0x')) {
        data = data.substring(2);
    }
    if (!/^([0-9a-fA-F]{2})*$/.test(data)) {
        throw new Error('invalid hex input');
    }
    const result = new Uint8Array(data.length / 2);
    for (let i = 0; i < result.length; i++)
        result[i] = parseInt(data.substring(i * 2, i * 2 + 2), 16);
    return result;
};
const encodeHex = (() => {
    const lut = new Array(0x100);
    for (let i = 0; i < 0x100; i++)
        lut[i] = i.toString(16).padStart(2, '0');
    return (data) => {
        const result = new Array(data.length);
        for (let i = 0; i < data.length; i++)
            result[i] = lut[data[i]];
        return '0x' + result.join('');
    };
})();
const decodeAbiData = (types, data) => {
    const decoded = ethers_1.AbiCoder.defaultAbiCoder().decode(types, data);
    // make an array because the Result type from ethers is annoying
    const result = new Array(types.length);
    for (let i = 0; i < decoded.length; i++)
        result[i] = decoded[i];
    return result;
};
// check if a given bigint can safely be represented in a number
const isSafeNumber = (val) => {
    return val < BigInt(Number.MAX_SAFE_INTEGER);
};
// try and parse an offset from the data
// returns the word as a number if it's a potentially valid offset into the data
const tryParseOffset = (data, pos) => {
    const word = data.slice(pos, pos + 32);
    if (word.length === 0)
        return null;
    const bigOffset = BigInt(encodeHex(word));
    // can't be huge
    if (!isSafeNumber(bigOffset))
        return null;
    const offset = Number(bigOffset);
    // must be located in the correct region of calldata
    if (offset <= pos || offset >= data.length)
        return null;
    // must be a multiple of 32
    if (offset % 32 !== 0)
        return null;
    return offset;
};
// try and parse a length from the data
// returns the word as a number if it's a potentially valid length for the data
const tryParseLength = (data, offset) => {
    const word = data.slice(offset, offset + 32);
    if (word.length === 0)
        return null;
    const bigLength = BigInt(encodeHex(word));
    // can't be huge
    if (!isSafeNumber(bigLength))
        return null;
    const length = Number(bigLength);
    // must be valid
    if (offset + 32 + length > data.length)
        return null;
    return length;
};
// split a string into chunks of given length
const chunkString = (str, len) => {
    const result = [];
    const size = Math.ceil(str.length / len);
    let offset = 0;
    for (let i = 0; i < size; i++) {
        result.push(str.substring(offset, offset + len));
        offset += len;
    }
    return result;
};
// count the number of leading zeros
const countLeadingZeros = (arr) => {
    let count = 0;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] != 0)
            break;
        count++;
    }
    return count;
};
// count the number of trailing zeros
const countTrailingZeros = (arr) => {
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != 0)
            break;
        count++;
    }
    return count;
};
// pretty print the potential param
const formatParam = (p) => {
    if (ethers_1.ParamType.isParamType(p)) {
        return p.format();
    }
    return `dynamic(offset=${p.offset},len=${p.length})`;
};
const formatParams = (params) => {
    return `${params.map((v) => v.format()).join(',')}`;
};
const generateConsistentResult = (params) => {
    if (params.length === 0)
        return null;
    // console.log("generating consistent result");
    // params.forEach(v => console.log("  " + v.format()));
    if (params[0].isTuple() && params[0].components.length > 0) {
        if (params.find(v => !v.isTuple()) !== undefined)
            return null;
        // todo: is this wrong?
        if (new Set(params.map(v => v.components.length)).size !== 1)
            return null;
        const components = [];
        for (let i = 0; i < params[0].components.length; i++) {
            const component = generateConsistentResult(params.map(v => v.components[i]));
            if (!component)
                return null;
            components.push(component);
        }
        return ethers_1.ParamType.from(`(${formatParams(components)})`);
    }
    if (params[0].isArray()) {
        if (params.find(v => !v.isArray()) !== undefined)
            return null;
        const arrayChildren = generateConsistentResult(params.map(v => v.arrayChildren));
        if (!arrayChildren)
            return null;
        return ethers_1.ParamType.from(`${arrayChildren.format()}[]`);
    }
    const consistencyChecker = new Set();
    for (const param of params) {
        let v = param.format();
        if (v === '()[]')
            v = 'bytes';
        consistencyChecker.add(v);
    }
    if (consistencyChecker.size !== 1)
        return null;
    return ethers_1.ParamType.from(consistencyChecker.values().next().value);
};
// decode a well formed tuple using backtracking
// for each parameter that we think we've identified, add it to collectedParams and backtrack
// this allows us to perform dfs through the entire search space without needing to implement the requisite data structure
const decodeWellFormedTuple = (
// current depth, for debugging purposes
depth, 
// the current data (calldata for top level, dynamic data if decoding a dynamic input)
data, 
// the current parameter being decoded
paramIdx, 
// the total number of parameters identified
collectedParams, 
// the offset at which the static calldata ends
endOfStaticCalldata, 
// if we expected a specific number of elements in this tuple
expectedLength, 
// if this tuple is an element in an array, every element should either be dynamic (have a length) or not (no length)
isDynamicArrayElement) => {
    const debug = (msg, ...args) => {
        // console.log("  ".repeat(depth) + msg, ...args);
    };
    // check if the generated params are actually valid by attempting to decode the parameters
    // note that we need to actually check that the generated results are valid (we do this by calling toString)
    const testParams = (params) => {
        if (!params)
            return false;
        try {
            decodeAbiData(params, data);
            return true;
        }
        catch (e) {
            debug('fail: got illegal parameters', formatParams(params));
            return false;
        }
    };
    // if (paramIdx === 0) {
    //     debug('backtracking');
    //     debug('input:');
    //     chunkString(encodeToHex(data).substring(2), 64)
    //         .forEach((v, i) =>
    //             debug('  ' + i.toString(16) + ' => ' + v),
    //         );
    // }
    const paramOffset = paramIdx * 32;
    if (paramOffset < endOfStaticCalldata) {
        // we're still in the static region. determine the next param and recurse
        // first, check if this parameter is dynamic
        // if it's dynamic, it should be an offset into calldata
        const maybeOffset = tryParseOffset(data, paramOffset);
        if (maybeOffset !== null) {
            const maybeLength = tryParseLength(data, maybeOffset);
            debug(`parameter ${paramIdx} might be dynamic, got offset ${maybeOffset}, len ${maybeLength}, is dynamic element ${isDynamicArrayElement}`);
            if (maybeLength !== null && (isDynamicArrayElement === null || isDynamicArrayElement === true)) {
                const fragment = decodeWellFormedTuple(depth, data, paramIdx + 1, [...collectedParams, { offset: maybeOffset, length: maybeLength }], Math.min(endOfStaticCalldata, maybeOffset), expectedLength, isDynamicArrayElement);
                if (testParams(fragment)) {
                    return fragment;
                }
            }
            if (isDynamicArrayElement === null || isDynamicArrayElement === false) {
                const fragment = decodeWellFormedTuple(depth, data, paramIdx + 1, [...collectedParams, { offset: maybeOffset, length: null }], Math.min(endOfStaticCalldata, maybeOffset), expectedLength, isDynamicArrayElement);
                if (testParams(fragment)) {
                    return fragment;
                }
            }
        }
        // only assume it's static if we're allowed to
        if (isDynamicArrayElement !== null) {
            return null;
        }
        const fragment = decodeWellFormedTuple(depth, data, paramIdx + 1, [...collectedParams, ethers_1.ParamType.from('bytes32')], endOfStaticCalldata, expectedLength, isDynamicArrayElement);
        if (testParams(fragment)) {
            return fragment;
        }
        return null;
    }
    // time to resolve our dynamic variables
    debug('reached end of static calldata, resolving dynamic variables', collectedParams.map(formatParam));
    if (expectedLength !== null && collectedParams.length !== expectedLength) {
        debug(`fail: expected ${expectedLength} elements in the tuple but got ${collectedParams.length} instead`);
        return null;
    }
    const maybeResolveDynamicParam = (idx) => {
        const param = collectedParams[idx];
        if (ethers_1.ParamType.isParamType(param)) {
            return param;
        }
        const nextDynamicParam = collectedParams.find((v, i) => i > idx && !ethers_1.ParamType.isParamType(v));
        const isTrailingDynamicParam = nextDynamicParam === undefined;
        // note that the length of the array != the number of bytes (bytes vs uint[])
        const maybeDynamicElementLen = param.length;
        // extract the data. note that this expects the data to not be overlapping
        const dynamicDataStart = param.offset + (maybeDynamicElementLen !== null ? 32 : 0);
        const dynamicDataEnd = isTrailingDynamicParam ? data.length : nextDynamicParam.offset;
        const dynamicData = data.slice(dynamicDataStart, dynamicDataEnd);
        debug(`param ${idx} is ${dynamicDataStart} -> ${dynamicDataEnd} (${dynamicData.length} bytes, ${maybeDynamicElementLen} elements)`);
        if (maybeDynamicElementLen === null) {
            // we don't have a length. what does this mean?
            // - it can't be a bytes/string, because those must have a length
            // - it can't be a dynamic array, because those also must have a length
            // - therefore, it must either be a simple tuple or a static array (which we treat identically)
            debug('trying to decode simple dynamic element', idx);
            const params = decodeWellFormedTuple(depth + 1, dynamicData, 0, [], dynamicData.length, null, null);
            if (params === null) {
                return undefined;
            }
            return ethers_1.ParamType.from(`(${formatParams(params)})`);
        }
        if (maybeDynamicElementLen === 0) {
            // if the element declared zero length, return a sentinel value
            // this could happen if there is:
            // - empty string/bytes
            // - empty dynamic array
            // we can't distinguish between the two, so return the special marker
            return ethers_1.ParamType.from('()[]');
        }
        if (maybeDynamicElementLen === dynamicData.length ||
            (dynamicData.length % 32 === 0 &&
                maybeDynamicElementLen === dynamicData.length - countTrailingZeros(dynamicData))) {
            // if either condition is true, then this must be a bytestring:
            // - has exactly the same number of bytes as it claims in the length
            // - is right-padded with zeroes to the next word
            return ethers_1.ParamType.from('bytes');
        }
        // from here on out it gets a bit ambiguous
        // we track all possible results and pick the best one at the end
        const allResults = [];
        // let's pretend that what we have is an array of dynamically sized elements
        // where each element has a length prefix. this one is easy to visualize
        // ex: func(string[])
        debug('decoding assuming length');
        const decodedAssumingLength = decodeWellFormedTuple(depth + 1, dynamicData, 0, [], dynamicData.length, maybeDynamicElementLen, true);
        if (decodedAssumingLength) {
            allResults.push(decodedAssumingLength);
        }
        // let's also pretend that what we have is an array of dynamically sized elements
        // but each element itself *does not* have a length prefix
        // this could happen if we're decoding an array of tuples, where one of the elements
        // is dynamically sized
        // ex: func((uint256,string)[])
        debug('decoding assuming no length');
        const decodedAssumingNoLength = decodeWellFormedTuple(depth + 1, dynamicData, 0, [], dynamicData.length, maybeDynamicElementLen, false);
        if (decodedAssumingNoLength) {
            allResults.push(decodedAssumingNoLength);
        }
        {
            // finally, let's pretend that what we have is an array of statically sized elements
            // in this case, each element must take the same number of words, so we calculate
            // how many words each element needs and manually decode that
            debug('decoding assuming static');
            const numWords = dynamicData.length / 32;
            const wordsPerElement = Math.floor(numWords / maybeDynamicElementLen);
            if (numWords % maybeDynamicElementLen !== 0 && !isTrailingDynamicParam) {
                // only the trailing param may be right padded
                // debug('fail: got uneven dynamic data', 'numWords=' + numWords, 'maybeLength=' + maybeDynamicElementLen);
                // return undefined;
            }
            const staticParseParams = [];
            for (let elemIdx = 0; elemIdx < maybeDynamicElementLen; elemIdx++) {
                const params = decodeWellFormedTuple(depth + 1, dynamicData.slice(elemIdx * wordsPerElement * 32, (elemIdx + 1) * wordsPerElement * 32), 0, [], wordsPerElement * 32, null, null);
                if (params === null || params.length === 0) {
                    debug('fail: to decode element', elemIdx);
                    return undefined;
                }
                if (params.length > 1) {
                    // multiple types, wrap it in a tuple
                    staticParseParams.push(ethers_1.ParamType.from(`(${formatParams(params)})`));
                }
                else {
                    // one type, all good
                    staticParseParams.push(params[0]);
                }
            }
            allResults.push(staticParseParams);
        }
        const validResults = allResults
            // find a consistent result
            .map((results) => generateConsistentResult(results))
            // filter out things that were not consistent or useless
            .filter((v) => v !== null && v.format() !== '()[]')
            // how do we know which one is best? usually shorter is better (less complex)
            .sort((a, b) => a.format().length - b.format().length);
        if (validResults.length === 0) {
            debug('fail: got no valid results');
            return undefined;
        }
        debug('got valid results', validResults.map((v) => v.format()).join(' / '));
        return ethers_1.ParamType.from(`${validResults[0].format()}[]`);
    };
    const finalParams = [];
    for (let i = 0; i < collectedParams.length; i++) {
        debug('resolving param', i);
        const decoded = maybeResolveDynamicParam(i);
        if (!decoded) {
            debug('fail: could not resolve param', i);
            return null;
        }
        finalParams.push(decoded);
    }
    const valid = testParams(finalParams);
    debug('resolved params', finalParams.map(formatParam), valid);
    return valid ? finalParams : null;
};
// given an array of types, try to find the greatest common denominator between them all
const mergeTypes = (types) => {
    if (types.length === 0) {
        // nothing to do
        return ethers_1.ParamType.from('()');
    }
    if (types.length === 1) {
        return types[0];
    }
    const baseTypeChecker = new Set(types.map((v) => v.baseType));
    if (baseTypeChecker.size === 1) {
        const baseType = baseTypeChecker.values().next().value;
        if (baseType === 'tuple') {
            const componentTypes = [];
            for (let i = 0; i < types.length; i++) {
                const type = types[i];
                if (!type.isTuple())
                    throw new Error('unexpected');
                componentTypes.push(type.components);
            }
            const componentLengthChecker = new Set(componentTypes.map((v) => v.length));
            if (componentLengthChecker.size !== 1) {
                // inconsistent
                return ethers_1.ParamType.from('()');
            }
            const componentLength = componentLengthChecker.values().next().value;
            const mergedTypes = [];
            for (let i = 0; i < componentLength; i++) {
                mergedTypes.push(mergeTypes(componentTypes.map((v) => v[i])));
            }
            return ethers_1.ParamType.from(`(${formatParams(mergedTypes)})`);
        }
        if (baseType === 'array') {
            const childrenTypes = [];
            for (let i = 0; i < types.length; i++) {
                const type = types[i];
                if (!type.isArray())
                    throw new Error('unexpected');
                childrenTypes.push(type.arrayChildren);
            }
            return ethers_1.ParamType.from(`${mergeTypes(childrenTypes).format()}[]`);
        }
    }
    const typeChecker = new Set(types.map((v) => v.type));
    if (typeChecker.size === 1) {
        return types[0];
    }
    if (typeChecker.has('bytes')) {
        return ethers_1.ParamType.from('bytes');
    }
    if (typeChecker.has('uint256')) {
        return ethers_1.ParamType.from('uint256');
    }
    return ethers_1.ParamType.from('bytes32');
};
// given an array of basic types (only bytes32, bytes, arrays, and tuples allowed) and a list of values,
// try and find the most concrete types acceptable. for example, a bytes32 might be inferred as a uint16 or a bytes4
const inferTypes = (params, vals) => {
    return params.map((param, idx) => {
        const val = vals[idx];
        if (param.isTuple()) {
            return ethers_1.ParamType.from(`(${formatParams(inferTypes(param.components, val))})`);
        }
        if (param.isArray()) {
            const repeatChildTypes = Array(val.length).fill(param.arrayChildren);
            return ethers_1.ParamType.from(`${mergeTypes(inferTypes(repeatChildTypes, val)).format()}[]`);
        }
        if (param.type === 'bytes32') {
            const leadingZeros = countLeadingZeros(decodeHex(val));
            const trailingZeros = countTrailingZeros(decodeHex(val));
            if (leadingZeros >= 12 && leadingZeros <= 17) {
                // it's probably very hard to mine more leading zeros than that
                return ethers_1.ParamType.from('address');
            }
            if (leadingZeros > 16) {
                return ethers_1.ParamType.from('uint256');
            }
            if (trailingZeros > 0) {
                return ethers_1.ParamType.from(`bytes${32 - trailingZeros}`);
            }
            return ethers_1.ParamType.from('bytes32');
        }
        if (param.type === 'bytes') {
            try {
                new TextDecoder('utf-8', { fatal: true }).decode(decodeHex(val));
                return ethers_1.ParamType.from('string');
            }
            catch (_a) { }
            return ethers_1.ParamType.from('bytes');
        }
        return param;
    });
};
/*
assume the calldata is "well-formed". by well-formed, we mean that all the static parameters come first,
then all the dynamic parameters come after. we assume there is no overlaps in dynamic parameters
and all trailing zeros are explicitly specified
 */
const guessAbiEncodedData = (bytes) => {
    const data = decodeHex(bytes);
    const params = decodeWellFormedTuple(0, data, 0, [], data.length, null, null);
    if (!params) {
        return null;
    }
    return inferTypes(params, decodeAbiData(params, data));
};
exports.guessAbiEncodedData = guessAbiEncodedData;
const guessFragment = (calldata) => {
    const bytes = decodeHex(calldata);
    if (bytes.length === 0)
        return null;
    const params = (0, exports.guessAbiEncodedData)(bytes.slice(4));
    if (!params) {
        return null;
    }
    const selector = encodeHex(bytes.slice(0, 4)).substring(2);
    return ethers_1.FunctionFragment.from(`guessed_${selector}(${formatParams(params)})`);
};
exports.guessFragment = guessFragment;
