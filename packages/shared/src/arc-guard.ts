/**
 * arc-guard — client-side protection against Arc's "accepted but never mined" transactions.
 *
 * Problem (reproduced live on Arc testnet, see docs/feedback-arc-circle.md): a transaction whose max fee is under the chain's
 * minimum base fee (20 gwei) is ACCEPTED by `eth_sendRawTransaction` (a tx hash comes back), stays "pending"
 * forever, and blocks every later transaction from the same account, even correctly priced ones. Nothing reports
 * an error, so an unattended signer (an AI agent, a keeper) just stops.
 *
 * What this module does:
 *   1. `arcFloor`      – reads the live minimum base fee from the chain instead of hard-coding it.
 *   2. `guardFee`      – refuses to sign/send a transaction under the floor, with a typed error.
 *   3. `diagnose`      – reports an account's confirmed vs pending nonce and the floor.
 *   4. `unwedge`       – replaces the stuck nonce with a correctly priced zero-value self-send (replace-by-fee).
 *   5. `sendArcTx`     – guard → send at the CONFIRMED nonce → bounded wait → automatic fee bump and retry.
 */
import type { Account, Chain, Hash, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";

export const ARC_FLOOR_FALLBACK = 20_000_000_000n; // 20 gwei, used only if the chain cannot be read
const GWEI = 1_000_000_000n;

export class ArcUnderpricedError extends Error {
  constructor(
    public readonly maxFeePerGas: bigint,
    public readonly floor: bigint,
  ) {
    super(
      `maxFeePerGas ${maxFeePerGas / GWEI} gwei is below Arc's minimum base fee of ${floor / GWEI} gwei. ` +
        `Arc's RPC would accept this transaction and then never mine it, blocking the account's later transactions.`,
    );
    this.name = "ArcUnderpricedError";
  }
}

type Pub = PublicClient<Transport, Chain | undefined>;
type Wal = WalletClient<Transport, Chain | undefined, Account>;

/** Live minimum fee: the latest block's base fee (Arc never lets it fall below 20 gwei on testnet). */
export async function arcFloor(client: Pub): Promise<bigint> {
  try {
    const block = await client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? 0n;
    return base > ARC_FLOOR_FALLBACK ? base : ARC_FLOOR_FALLBACK;
  } catch {
    return ARC_FLOOR_FALLBACK;
  }
}

/** Throws `ArcUnderpricedError` if the fee would be accepted-but-never-mined. Call before signing. */
export async function guardFee(client: Pub, fee: { maxFeePerGas?: bigint; gasPrice?: bigint }): Promise<void> {
  const max = fee.maxFeePerGas ?? fee.gasPrice;
  if (max === undefined) return; // no explicit fee: the chain's fee estimator will fill it in
  const floor = await arcFloor(client);
  if (max < floor) throw new ArcUnderpricedError(max, floor);
}

export interface AccountDiagnosis {
  address: `0x${string}`;
  /** transactions mined so far */
  confirmedNonce: number;
  /** nonce the node would hand out next (counts txs sitting in its pool) */
  pendingNonce: number;
  floor: bigint;
  /** true when the node's pool holds transactions for this account that have not been mined */
  hasPendingTxs: boolean;
}

export async function diagnose(client: Pub, address: `0x${string}`): Promise<AccountDiagnosis> {
  const [confirmed, pending, floor] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
    arcFloor(client),
  ]);
  return { address, confirmedNonce: confirmed, pendingNonce: pending, floor, hasPendingTxs: pending > confirmed };
}

/**
 * Replace-by-fee for one nonce: a zero-value self-send priced at 1.5× the floor. If a stuck transaction holds the
 * nonce it is replaced; if not, this is just a harmless ~$0.0005 transaction that advances the nonce.
 */
export async function unwedge(wallet: Wal, client: Pub, nonce?: number): Promise<{ hash: Hash; receipt: TransactionReceipt; nonce: number }> {
  const account = wallet.account;
  const n = nonce ?? (await client.getTransactionCount({ address: account.address, blockTag: "latest" }));
  const floor = await arcFloor(client);
  const fee = (floor * 3n) / 2n;
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: account.address,
    value: 0n,
    gas: 21_000n,
    nonce: n,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: GWEI,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, receipt, nonce: n };
}

export interface SendArcTxOptions {
  /** how long to wait for each attempt before bumping the fee (default 12 s) */
  attemptTimeoutMs?: number;
  /** how many times to bump and resend (default 3) */
  maxBumps?: number;
}

type TxRequest = { to?: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint; maxFeePerGas?: bigint };

/**
 * Sends a transaction the safe way on Arc: guard the fee, use the CONFIRMED nonce (so one stuck transaction cannot
 * poison the next ones), wait a bounded time, and if no receipt arrives replace the same nonce with a +25 % fee.
 * Do not run two `sendArcTx` calls for the same account at once (they would share a nonce).
 */
export async function sendArcTx(wallet: Wal, client: Pub, req: TxRequest, opts: SendArcTxOptions = {}) {
  const { attemptTimeoutMs = 12_000, maxBumps = 3 } = opts;
  const account = wallet.account;
  const floor = await arcFloor(client);
  let fee = req.maxFeePerGas ?? (floor * 12n) / 10n;
  await guardFee(client, { maxFeePerGas: fee });
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "latest" });
  const gas = req.gas ?? (await client.estimateGas({ account, to: req.to, data: req.data, value: req.value, maxFeePerGas: fee }));

  const sent: Hash[] = [];
  for (let attempt = 0; attempt <= maxBumps; attempt++) {
    const hash = await wallet.sendTransaction({
      account,
      chain: wallet.chain,
      to: req.to,
      data: req.data,
      value: req.value,
      gas,
      nonce,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: GWEI,
    });
    sent.push(hash);
    // Any attempt for this nonce may be the one that lands, so wait on all of them.
    const landed = await Promise.race(
      sent.map((h) => client.waitForTransactionReceipt({ hash: h, timeout: attemptTimeoutMs }).catch(() => null)),
    );
    if (landed) return { hash: landed.transactionHash, receipt: landed, attempts: attempt + 1 };
    fee = (fee * 125n) / 100n; // replace-by-fee needs a bump of at least 10 %
  }
  throw new Error(`transaction not mined after ${maxBumps + 1} attempts (nonce ${nonce}); run \`pnpm arc:doctor ${account.address} --fix\``);
}
