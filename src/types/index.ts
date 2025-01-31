import * as fs from "fs";
import * as starknet from "../starknet-types";
import { StarknetPluginError } from "../starknet-plugin-error";
import {
    CHECK_STATUS_RECOVER_TIMEOUT,
    QUERY_VERSION,
    TRANSACTION_VERSION,
    HEXADECIMAL_REGEX,
    CHECK_STATUS_TIMEOUT
} from "../constants";
import { adaptLog, copyWithBigint, formatSpaces, isEntryAContructor, sleep, warn } from "../utils";
import { adaptInputUtil, adaptOutputUtil } from "../adapt";
import { HardhatRuntimeEnvironment, Wallet } from "hardhat/types";
import { hash } from "starknet";
import { StarknetWrapper } from "../starknet-wrappers";

/**
 * According to: https://starknet.io/docs/hello_starknet/intro.html#interact-with-the-contract
 * Not using an enum to avoid code duplication and reverse mapping.
 */
export type TxStatus =
    /** The transaction passed the validation and entered the pending block. */
    | "PENDING"

    /** The transaction has not been received yet (i.e., not written to storage). */
    | "NOT_RECEIVED"

    /** The transaction was received by the operator. */
    | "RECEIVED"

    /** The transaction failed validation and thus was skipped. */
    | "REJECTED"

    /** The transaction passed the validation and entered an actual created block. */
    | "ACCEPTED_ON_L2"

    /** The transaction was accepted on-chain. */
    | "ACCEPTED_ON_L1";

export type InvokeResponse = string;

export type StarknetContractFactoryConfig = StarknetContractConfig & {
    casmPath?: string;
    metadataPath: string;
    hre: HardhatRuntimeEnvironment;
};

export interface StarknetContractConfig {
    abiPath: string;
    hre: HardhatRuntimeEnvironment;
}

export type Numeric = number | bigint;

/**
 * Object whose keys are strings (names) and values are any object.
 */
export interface StringMap {
    [key: string]: any;
}

/**
 * Object holding the event name and have a proprety data of type StingMap.
 */
export interface DecodedEvent {
    name: string;
    data: StringMap;
}

/**
 * Enumerates the ways of interacting with a contract.
 */
export class InteractChoice {
    static readonly INVOKE = new InteractChoice(["invoke"], "invoke", true, TRANSACTION_VERSION);

    static readonly CALL = new InteractChoice(["call"], "call", false, QUERY_VERSION);

    static readonly ESTIMATE_FEE = new InteractChoice(
        ["invoke", "--estimate_fee"],
        "estimateFee",
        false,
        QUERY_VERSION
    );

    private constructor(
        /**
         * The way it's supposed to be used passed to CLI commands.
         */
        public readonly cliCommand: string[],
        /**
         * The way it's supposed to be used internally in code.
         */
        public readonly internalCommand: keyof StarknetContract,

        /**
         * Indicates whether the belonging CLI option allows specifying max_fee.
         */
        public readonly allowsMaxFee: boolean,

        /**
         * The version of the transaction.
         */
        public transactionVersion: Numeric
    ) {}
}

export function extractClassHash(response: string) {
    return extractFromResponse(response, /^Contract class hash: (.*)$/m);
}

function extractTxHash(response: string) {
    return extractFromResponse(response, /^Transaction hash: (.*)$/m);
}

function extractFromResponse(response: string, regex: RegExp) {
    const matched = response.match(regex);
    if (!matched || !matched[1]) {
        throw new StarknetPluginError(
            `Could not parse response. Check that you're using the correct network. Response received: ${response}`
        );
    }
    return matched[1];
}

/**
 * The object returned by starknet tx_status.
 */
type StatusObject = {
    block_hash: string;
    tx_status: TxStatus;
    tx_failure_reason?: starknet.TxFailureReason;
};

async function checkStatus(hash: string, starknetWrapper: StarknetWrapper): Promise<StatusObject> {
    const executed = await starknetWrapper.getTxStatus({
        hash
    });
    if (executed.statusCode) {
        throw new StarknetPluginError(executed.stderr.toString());
    }

    const response = executed.stdout.toString();
    try {
        const responseParsed = JSON.parse(response);
        return responseParsed;
    } catch (err) {
        throw new StarknetPluginError(`Cannot interpret the following: ${response}`);
    }
}

const ACCEPTABLE_STATUSES: TxStatus[] = ["PENDING", "ACCEPTED_ON_L2", "ACCEPTED_ON_L1"];
export function isTxAccepted(statusObject: StatusObject): boolean {
    return ACCEPTABLE_STATUSES.includes(statusObject.tx_status);
}

const UNACCEPTABLE_STATUSES: TxStatus[] = ["REJECTED"];
function isTxRejected(statusObject: StatusObject): boolean {
    return UNACCEPTABLE_STATUSES.includes(statusObject.tx_status);
}

export async function iterativelyCheckStatus(
    txHash: string,
    starknetWrapper: StarknetWrapper,
    resolve: (status: string) => void,
    reject: (reason: Error) => void,
    retryCount = 10
) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        let count = retryCount;
        let statusObject;
        let error;
        while (count > 0) {
            // This promise is rejected usually if the network is unavailable
            statusObject = await checkStatus(txHash, starknetWrapper).catch((reason) => {
                error = reason;
                return undefined;
            });
            // Check count at 1 to avoid unnecessary waiting(sleep) in the last iteration
            if (statusObject || count === 1) {
                break;
            }

            await sleep(CHECK_STATUS_RECOVER_TIMEOUT);
            warn("Retrying transaction status check...");
            count--;
        }

        if (!statusObject) {
            warn("Checking transaction status failed.");
            return reject(error);
        } else if (isTxAccepted(statusObject)) {
            return resolve(statusObject.tx_status);
        } else if (isTxRejected(statusObject)) {
            return reject(
                new Error(
                    "Transaction rejected. Error message:\n\n" +
                        adaptLog(statusObject.tx_failure_reason.error_message)
                )
            );
        }

        await sleep(CHECK_STATUS_TIMEOUT);
    }
}

/**
 * Reads ABI from `abiPath` and converts it to an object for lookup by name.
 * @param abiPath the path where ABI is stored on disk
 * @returns an object mapping ABI entry names with their values
 */
function readAbi(abiPath: string): starknet.Abi {
    const abiRaw = fs.readFileSync(abiPath).toString();
    const abiArray = JSON.parse(abiRaw);
    const abi: starknet.Abi = {};
    for (const abiEntry of abiArray) {
        if (!abiEntry.name) {
            const msg = `Abi entry has no name: ${abiEntry}`;
            throw new StarknetPluginError(msg);
        }
        abi[abiEntry.name] = abiEntry;
    }
    return abi;
}

/**
 * Add `signature` elements to to `starknetArgs`, if there are any.
 * @param signature array of transaction signature elements
 */
function handleSignature(signature: Array<Numeric>): string[] {
    if (signature) {
        return signature.map((s) => s.toString());
    }
    return [];
}

/**
 * Extract events from the ABI.
 * @param abi the path where ABI is stored on disk.
 * @returns an object mapping ABI entry names with their values.
 */
function extractEventSpecifications(abi: starknet.Abi) {
    const events: starknet.EventAbi = {};
    for (const abiEntryName in abi) {
        if (abi[abiEntryName].type === "event") {
            const event = <starknet.EventSpecification>abi[abiEntryName];
            const encodedEventName = hash.getSelectorFromName(event.name);
            events[encodedEventName] = event;
        }
    }
    return events;
}

export function parseFeeEstimation(raw: string): starknet.FeeEstimation {
    const matchedAmount = raw.match(/^The estimated fee is: (\d*) WEI \(.* ETH\)\./m);
    const matchedGasUsage = raw.match(/^Gas usage: (\d*)/m);
    const matchedGasPrice = raw.match(/^Gas price: (\d*) WEI/m);
    if (matchedAmount && matchedGasUsage && matchedGasPrice) {
        return {
            amount: BigInt(matchedAmount[1]),
            unit: "wei",
            gas_price: BigInt(matchedGasPrice[1]),
            gas_usage: BigInt(matchedGasUsage[1])
        };
    }
    throw new StarknetPluginError(`Cannot parse fee estimation response:\n${raw}`);
}

/**
 * Returns a modified copy of the provided object with its blockNumber set to pending.
 * @param options the options object with a blockNumber key
 */
function defaultToPendingBlock<T extends { blockNumber?: BlockNumber }>(options: T): T {
    const adaptedOptions = copyWithBigint<T>(options);
    if (adaptedOptions.blockNumber === undefined) {
        // using || operator would not handle the zero case correctly
        adaptedOptions.blockNumber = "pending";
    }
    return adaptedOptions;
}

export interface DeclareOptions {
    token?: string;
    signature?: Array<Numeric>;
    sender?: string; // address
    nonce?: Numeric;
    maxFee?: Numeric;
    overhead?: number;
    version?: number;
}

export interface DeployOptions {
    salt?: string;
    unique?: boolean;
    maxFee?: Numeric;
    nonce?: Numeric;
}

export interface DeployAccountOptions {
    maxFee?: Numeric;
    overhead?: number;
}

export interface InvokeOptions {
    signature?: Array<Numeric>;
    wallet?: Wallet;
    nonce?: Numeric;
    maxFee?: Numeric;
    overhead?: number;
}

export interface CallOptions {
    signature?: Array<Numeric>;
    wallet?: Wallet;
    blockNumber?: BlockNumber;
    nonce?: Numeric;
    maxFee?: Numeric;
    rawOutput?: boolean;
    token?: string;
    salt?: string;
    unique?: boolean;
    sender?: string; // address
}

export type EstimateFeeOptions = CallOptions;

export type InteractOptions = InvokeOptions | CallOptions | EstimateFeeOptions;

export type ContractInteractionFunction = (
    functionName: string,
    args?: StringMap,
    options?: InteractOptions
) => Promise<any>;

export type BlockNumber = number | "pending" | "latest";

export interface BlockIdentifier {
    blockNumber?: BlockNumber;
    blockHash?: string;
}

export type SieraEntryPointsByType = {
    CONSTRUCTOR: SieraContractEntryPointFields[];
    EXTERNAL: SieraContractEntryPointFields[];
    L1_HANDLER: SieraContractEntryPointFields[];
};

export type SieraContractEntryPointFields = {
    selector: string;
    function_idx: number;
};

export type NonceQueryOptions = BlockIdentifier;

export class StarknetContractFactory {
    private hre: HardhatRuntimeEnvironment;
    public abi: starknet.Abi;
    public abiPath: string;
    private constructorAbi: starknet.CairoFunction;
    public metadataPath: string;
    public casmPath: string;
    private classHash: string;

    constructor(config: StarknetContractFactoryConfig) {
        this.hre = config.hre;
        this.abiPath = config.abiPath;
        this.abi = readAbi(this.abiPath);
        this.metadataPath = config.metadataPath;
        this.casmPath = config.casmPath;

        // find constructor
        for (const abiEntryName in this.abi) {
            const abiEntry = this.abi[abiEntryName];
            if (isEntryAContructor(abiEntry, config.hre.config.paths, this.casmPath)) {
                this.constructorAbi = <starknet.CairoFunction>abiEntry;
            }
        }
    }

    /**
     * Declare a contract class.
     * @param options optional arguments to class declaration
     * @returns transaction hash as a hex string
     */
    async declare(options: DeclareOptions = {}): Promise<string> {
        const executed = await this.hre.starknetWrapper.declare({
            contract: this.metadataPath,
            maxFee: (options.maxFee || 0).toString(),
            token: options.token,
            signature: handleSignature(options.signature),
            sender: options.sender,
            nonce: options.nonce?.toString()
        });
        if (executed.statusCode) {
            const msg = `Could not declare class: ${executed.stderr.toString()}`;
            throw new StarknetPluginError(msg);
        }

        const executedOutput = executed.stdout.toString();
        const txHash = extractTxHash(executedOutput);

        return new Promise((resolve, reject) => {
            iterativelyCheckStatus(
                txHash,
                this.hre.starknetWrapper,
                () => resolve(txHash),
                (error) => {
                    reject(new StarknetPluginError(`Declare transaction ${txHash}: ${error}`));
                }
            );
        });
    }

    handleConstructorArguments(constructorArguments: StringMap): string[] {
        if (!this.constructorAbi) {
            const argsProvided = Object.keys(constructorArguments || {}).length;
            if (argsProvided) {
                const msg = `No constructor arguments required but ${argsProvided} provided`;
                throw new StarknetPluginError(msg);
            }
            return [];
        }
        return adaptInputUtil(
            this.constructorAbi.name,
            constructorArguments,
            this.constructorAbi.inputs,
            this.abi
        );
    }

    /**
     * Returns a contract instance with set address.
     * No address validity checks are performed.
     * @param address the address of a previously deployed contract
     * @returns the contract instance at the provided address
     */
    getContractAt(address: string) {
        if (!address) {
            throw new StarknetPluginError("No address provided");
        }
        if (typeof address !== "string" || !HEXADECIMAL_REGEX.test(address)) {
            throw new StarknetPluginError(
                `Address must be 0x-prefixed hex string. Got: "${address}".`
            );
        }
        const contract = new StarknetContract({
            abiPath: this.abiPath,
            hre: this.hre
        });
        contract.address = address;
        return contract;
    }

    getAbiPath() {
        return this.abiPath;
    }

    isCairo1() {
        return !!this.casmPath;
    }

    async getClassHash() {
        const method = this.isCairo1() ? "getSierraContractClassHash" : "getClassHash";
        this.classHash =
            this.classHash ?? (await this.hre.starknetWrapper[method](this.metadataPath));
        return this.classHash;
    }
}

export class StarknetContract {
    private hre: HardhatRuntimeEnvironment;
    private abi: starknet.Abi;
    private eventsSpecifications: starknet.EventAbi;
    private abiPath: string;
    private _address: string;
    public deployTxHash: string;

    constructor(config: StarknetContractConfig) {
        this.hre = config.hre;
        this.abiPath = config.abiPath;
        this.abi = readAbi(this.abiPath);
        this.eventsSpecifications = extractEventSpecifications(this.abi);
    }

    get address(): string {
        return this._address;
    }

    set address(address: string) {
        this._address = address;
        return;
    }

    /**
     * Set a custom abi and abi path to the contract
     * @param implementation the contract factory of the implementation to be set
     */
    setImplementation(implementation: StarknetContractFactory): void {
        this.abi = implementation.abi;
        this.abiPath = implementation.abiPath;
    }

    private async interact(
        choice: InteractChoice,
        functionName: string,
        args?: StringMap,
        options: InteractOptions = {}
    ) {
        if (!this.address) {
            throw new StarknetPluginError("Contract not deployed");
        }

        const adaptedInput = this.adaptInput(functionName, args);
        const executed = await this.hre.starknetWrapper.interact({
            choice,
            address: this.address,
            abi: this.abiPath,
            functionName: functionName,
            inputs: adaptedInput,
            signature: handleSignature(options.signature),
            wallet: options.wallet?.modulePath,
            account: options.wallet?.accountName,
            accountDir: options.wallet?.accountPath,
            blockNumber: "blockNumber" in options ? options.blockNumber : undefined,
            maxFee: options.maxFee?.toString(),
            nonce: options.nonce?.toString()
        });

        if (executed.statusCode) {
            const msg =
                `Could not perform ${choice.internalCommand} on ${functionName}.\n` +
                executed.stderr.toString() +
                "\n" +
                "Make sure to `invoke` and `estimateFee` through account, and `call` directly through contract.";
            const replacedMsg = adaptLog(msg);
            throw new StarknetPluginError(replacedMsg);
        }

        return executed;
    }

    /**
     * Invoke the function by name and optionally provide arguments in an array.
     * For a usage example @see {@link call}
     * @param functionName
     * @param args arguments to Starknet contract function
     * @options optional additions to invoking
     * @returns a Promise that resolves when the status of the transaction is at least `PENDING`
     */
    async invoke(
        functionName: string,
        args?: StringMap,
        options: InvokeOptions = {}
    ): Promise<InvokeResponse> {
        const executed = await this.interact(InteractChoice.INVOKE, functionName, args, options);
        const txHash = extractTxHash(executed.stdout.toString());

        return new Promise<string>((resolve, reject) => {
            iterativelyCheckStatus(
                txHash,
                this.hre.starknetWrapper,
                () => resolve(txHash),
                (error) => {
                    reject(new StarknetPluginError(`Invoke transaction ${txHash}: ${error}`));
                }
            );
        });
    }

    /**
     * Call the function by name and optionally provide arguments in an array.
     *
     * E.g. If your contract has a function
     * ```text
     * func double_sum(x: felt, y: felt) -> (res: felt):
     *     return (res=(x + y) * 2)
     * end
     * ```
     * then you would call it like:
     * ```typescript
     * const contract = ...;
     * const { res: sum } = await contract.call("double_sum", { x: 2, y: 3 });
     * console.log(sum);
     * ```
     * which would result in:
     * ```text
     * > 10n
     * ```
     *
     * If options.rawOutput, the Promised object holds a property `response` with an array of strings.
     *
     * @param functionName
     * @param args arguments to Starknet contract function
     * @param options optional additions to calling
     * @returns a Promise that resolves when the status of the transaction is at least `PENDING`
     */
    async call(
        functionName: string,
        args?: StringMap,
        options: CallOptions = {}
    ): Promise<StringMap> {
        const adaptedOptions = defaultToPendingBlock(options);
        const executed = await this.interact(
            InteractChoice.CALL,
            functionName,
            args,
            adaptedOptions
        );
        if (options.rawOutput) {
            return { response: executed.stdout.toString().split(" ") };
        }
        return this.adaptOutput(functionName, executed.stdout.toString());
    }

    /**
     * Computes L1-to-L2 message fee estimation
     * @param {string} functionName Function name for entry point selector
     * @param {StringMap} args - Arguments to Starknet contract function
     * @returns Fee estimation
     */
    async estimateMessageFee(functionName: string, args: StringMap) {
        // Check if functionName is annotated with @l1_handler
        const func = <starknet.CairoFunction>this.abi[functionName];

        if (!func?.type || func.type.toString() !== "l1_handler") {
            throw new StarknetPluginError(
                `Cannot estimate message fee on "${functionName}" - not an @l1_handler`
            );
        }
        const adaptedInput = this.adaptInput(functionName, args);
        // Remove value of from_address from the input array
        const fromAddress = adaptedInput.shift();
        return this.hre.starknetWrapper.estimateMessageFee(
            functionName,
            fromAddress,
            this.address,
            adaptedInput
        );
    }

    /**
     * Estimate the gas fee of executing `functionName` with `args`.
     * @param functionName
     * @param args arguments to Starknet contract function
     * @param options optional execution specifications
     * @returns an object containing the amount and the unit of the estimation
     */
    async estimateFee(
        functionName: string,
        args?: StringMap,
        options: EstimateFeeOptions = {}
    ): Promise<starknet.FeeEstimation> {
        const adaptedOptions = defaultToPendingBlock(options);
        const executed = await this.interact(
            InteractChoice.ESTIMATE_FEE,
            functionName,
            args,
            adaptedOptions
        );
        return parseFeeEstimation(executed.stdout.toString());
    }

    /**
     * Returns the ABI of the whole contract.
     * @returns contract ABI
     */
    getAbi(): starknet.Abi {
        return this.abi;
    }

    /**
     * Adapt structured `args` to unstructured array expected by e.g. Starknet CLI.
     * @param functionName the name of the function to adapt
     * @param args structured args
     * @returns unstructured args
     */
    adaptInput(functionName: string, args?: StringMap): string[] {
        const func = <starknet.CairoFunction>this.abi[functionName];
        if (!func) {
            const msg = `Function '${functionName}' doesn't exist on ${this.abiPath}.`;
            throw new StarknetPluginError(msg);
        }

        if (Array.isArray(args)) {
            throw new StarknetPluginError("Arguments should be passed in the form of an object.");
        }

        return adaptInputUtil(functionName, args, func.inputs, this.abi);
    }

    /**
     * Adapt unstructured `rawResult` to a structured object.
     * @param functionName the name of the function that produced the output
     * @param rawResult the function output as as unparsed space separated string
     * @returns structured output
     */
    adaptOutput(functionName: string, rawResult: string) {
        const func = <starknet.CairoFunction>this.abi[functionName];
        return adaptOutputUtil(rawResult, func.outputs, this.abi);
    }

    /**
     * Decode the events to a structured object with parameter names.
     * Only decodes the events originating from this contract.
     * @param events as received from the server.
     * @returns structured object with parameter names.
     * @throws if no events decoded
     */
    decodeEvents(events: starknet.Event[]): DecodedEvent[] {
        const decodedEvents: DecodedEvent[] = [];
        for (const event of events) {
            // skip events originating from other contracts, e.g. fee token
            if (parseInt(event.from_address, 16) !== parseInt(this.address, 16)) continue;

            const rawEventData = event.data.map(BigInt).join(" ");
            // encoded event name guaranteed to be at index 0
            const eventSpecification = this.eventsSpecifications[event.keys[0]];
            if (!eventSpecification) {
                const msg = `Event "${event.keys[0]}" doesn't exist in ${this.abiPath}.`;
                throw new StarknetPluginError(msg);
            }

            const adapted = adaptOutputUtil(rawEventData, eventSpecification.data, this.abi);
            decodedEvents.push({ name: eventSpecification.name, data: adapted });
        }

        if (decodedEvents.length === 0) {
            const msg = `No events were decoded. You might be using a wrong contract. ABI used for decoding: ${this.abiPath}`;
            throw new StarknetPluginError(msg);
        }
        return decodedEvents;
    }
}

export interface ContractClassConfig extends StarknetContractConfig {
    sierraProgram: string;
    contractClassVersion: string;
    entryPointsByType: SieraEntryPointsByType;
}

export class Cairo1ContractClass extends StarknetContract {
    protected sierraProgram: string;
    protected contractClassVersion: string;
    protected entryPointsByType: SieraEntryPointsByType;

    constructor(config: ContractClassConfig) {
        super(config);

        this.sierraProgram = config.sierraProgram;
        this.contractClassVersion = config.contractClassVersion;
        this.entryPointsByType = config.entryPointsByType;
    }

    /**
     * Returns the compiled class.
     * @returns object of a compiled contract class
     */
    getCompiledClass() {
        return {
            sierra_program: this.sierraProgram,
            entry_points_by_type: this.entryPointsByType,
            contract_class_version: this.contractClassVersion,
            abi: this.getFormattedAbi()
        };
    }

    getFormattedAbi() {
        const abiArr = Object.values(this.getAbi());
        return formatSpaces(JSON.stringify(abiArr));
    }
}
