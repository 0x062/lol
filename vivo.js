// bridge_script.js (v3 - Fokus Hanya Babylon -> Xion)

// --------------------------------------------------------------------------
// 1. IMPORTS
// --------------------------------------------------------------------------
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { calculateFee, GasPrice, coin } = require("@cosmjs/stargate");
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

// --------------------------------------------------------------------------
// 2. TELEGRAM REPORTER
// --------------------------------------------------------------------------
const { sendReport } = require('./telegramReporter');

// --------------------------------------------------------------------------
// 3. HELPER FUNCTIONS
// --------------------------------------------------------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logger = {
    _log: (prefix, msg) => console.log(`${new Date().toISOString()} ${prefix} ${msg}`),
    info: (msg) => logger._log(`[✓]`, msg),
    warn: (msg) => logger._log(`[⚠]`, msg),
    error: (msg) => logger._log(`[✗]`, msg),
    success: (msg) => logger._log(`[✅]`, msg),
    loading: (msg) => logger._log(`[⟳]`, msg),
};

let reportBuffer = [];
function bufferReport(text) {
    reportBuffer.push(text);
}

async function flushReport() {
    if (!reportBuffer.length) return;
    const messageToSend = reportBuffer.join("\n");
    try {
        logger.loading("Sending report to Telegram...");
        await sendReport(messageToSend);
        logger.success("Telegram report sent successfully!");
    } catch (err) {
        logger.error(`Telegram report failed: ${err.message}`);
    }
    reportBuffer = [];
}

function getRandomAmount(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// --------------------------------------------------------------------------
// 4. POLLING FUNCTION (UNION BUILD)
// --------------------------------------------------------------------------
async function pollUnionForPacketHash(txHash, chainName = "Babylon", retries = 50, intervalMs = 6000) {
    const POLLING_URL = process.env.UNION_POLLING_URL || "https://graphql.union.build/v1/graphql";
    const HEADERS = {
        'Accept': 'application/json', 'Content-Type': 'application/json',
        'Origin': 'https://app.union.build', 'Referer': 'https://app.union.build/',
    };
    const submissionHash = '0x' + txHash.toLowerCase();
    const data = {
        query: `query GetPacketHashBySubmissionTxHash($submission_tx_hash: String!) { v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) { packet_hash } }`,
        variables: { submission_tx_hash: submissionHash },
        operationName: "GetPacketHashBySubmissionTxHash"
    };
    logger.loading(`[UnionPoll-${chainName}] Polling for Packet Hash using ${submissionHash.substring(0, 15)}... (Max ${retries} tries)`);
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.post(POLLING_URL, data, { headers: HEADERS, timeout: 10000 });
            const resultData = res.data?.data?.v2_transfers;
            if (resultData && resultData.length > 0 && resultData[0].packet_hash) {
                logger.success(`[UnionPoll-${chainName}] Packet Hash found: ${resultData[0].packet_hash}`);
                return resultData[0].packet_hash;
            } else {
                logger.loading(`[UnionPoll-${chainName}] Waiting for packet... (Try ${i + 1}/${retries})`);
            }
        } catch (e) {
            const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
            logger.error(`[UnionPoll-${chainName}] Polling error: ${errorMessage.substring(0, 200)}...`);
            if (!e.response || e.code === 'ECONNABORTED' || e.response?.status >= 500) {
                 logger.warn(`[UnionPoll-${chainName}] Retrying after network/server error...`);
            }
        }
        await delay(intervalMs);
    }
    logger.warn(`[UnionPoll-${chainName}] Could not retrieve Packet Hash after ${retries} retries for Tx: ${txHash}`);
    return null;
}

// --------------------------------------------------------------------------
// 5. BRIDGE FUNCTION (BABYLON -> XION)
// --------------------------------------------------------------------------
async function sendBabylonToXionBridge(
    client, senderBabylonAddress, babylonContractAddress,
    messagePayloadTemplate, fundsForTx
) {
    const BABYLON_GAS_PRICE_STR = process.env.BABYLON_GAS_PRICE || "0.01ubbn";
    const BABYLON_GAS_LIMIT = parseInt(process.env.BABYLON_GAS_LIMIT || "700000");

    let payload = JSON.parse(JSON.stringify(messagePayloadTemplate));
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    if (!payload.send) payload.send = {};
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    const fee = calculateFee(BABYLON_GAS_LIMIT, GasPrice.fromString(BABYLON_GAS_PRICE_STR));

    logger.loading(`[Babylon] Sending ${fundsForTx[0].amount}${fundsForTx[0].denom} to contract ${babylonContractAddress}...`);
    try {
        const result = await client.execute(
            senderBabylonAddress, babylonContractAddress, payload, fee,
            "Babylon to Xion Bridge via JS Partner", fundsForTx
        );
        const babylonTxHash = result.transactionHash;
        logger.success(`[Babylon] Transaction sent! Hash: ${babylonTxHash}`);
        logger.info(`[Babylon->Union] Attempting to poll Union for packet hash...`);
        const packetHash = await pollUnionForPacketHash(babylonTxHash, "Babylon");
        if (packetHash) {
            bufferReport(`✅ Babylon -> Xion (${fundsForTx[0].amount} ${fundsForTx[0].denom}) | Babylon Tx: \`${babylonTxHash.substring(0, 6)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
            bufferReport(`✅ Babylon -> Xion (${fundsForTx[0].amount} ${fundsForTx[0].denom}) | Babylon Tx: \`${babylonTxHash.substring(0, 6)}...\` | ⚠ Union Packet N/A`);
        }
    } catch (err) {
        logger.error(`[Babylon] Transaction failed: ${err.message}`);
        if (err.message.includes("insufficient funds")) {
            logger.warn("[Babylon] Tip: Check if your Babylon wallet has enough funds for gas and transaction.");
        }
        bufferReport(`❌ Failed Babylon -> Xion: ${err.message.substring(0,100)}...`);
    }
}

// --------------------------------------------------------------------------
// 6. RUNNER FUNCTION
// --------------------------------------------------------------------------
async function runBabylonToXionTransfer() {
    logger.info("===== Starting Babylon -> Xion Transfer Process =====");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan di .env!");
        bufferReport("❌ MNEMONIC (untuk Babylon) tidak ada di .env!");
        return;
    }

    const babylonRpc = process.env.BABYLON_RPC_ENDPOINT;
    if (!babylonRpc) {
        logger.error("BABYLON_RPC_ENDPOINT tidak ditemukan di .env! Anda perlu mengisinya.");
        bufferReport("❌ BABYLON_RPC_ENDPOINT tidak ada di .env!");
        return;
    }

    const babylonContract = process.env.BABYLON_CONTRACT_ADDRESS || "bbn1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292q77945h";
    const minAmount = parseInt(process.env.BABYLON_TX_AMOUNT_MIN || "1000");
    const maxAmount = parseInt(process.env.BABYLON_TX_AMOUNT_MAX || "2000");
    const txDenom = process.env.BABYLON_TX_DENOM || "ubbn";
    const BABYLON_PREFIX = process.env.BABYLON_PREFIX || "bbn";

    try {
        logger.loading(`[Babylon] Preparing wallet with prefix '${BABYLON_PREFIX}'...`);
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: BABYLON_PREFIX });
        const [firstAccount] = await wallet.getAccounts();
        const senderBabylonAddress = firstAccount.address;
        logger.info(`[Babylon] Wallet Address: ${senderBabylonAddress}`);

        logger.loading(`[Babylon] Connecting to RPC (${babylonRpc}) to check balance...`);
        const client = await SigningCosmWasmClient.connectWithSigner(babylonRpc, wallet);
        const balance = await client.getBalance(senderBabylonAddress, txDenom);
        logger.info(`[Babylon] Current balance: ${balance.amount} ${balance.denom}`);

        const amountToSend = getRandomAmount(minAmount, maxAmount);
        if (BigInt(balance.amount) < BigInt(amountToSend)) {
            logger.error(`[Babylon] Insufficient funds. Needed: ${amountToSend}, Have: ${balance.amount}`);
            bufferReport(`❌ Babylon -> Xion: Saldo tidak cukup (Butuh: ${amountToSend}, Punya: ${balance.amount})`);
            return;
        }

        const babylonFunds = [coin(amountToSend.toString(), txDenom)];
        const babylonInstructionDefault = "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002a62626e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396365376576656e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003f78696f6e316a30687036717a7467617a61377430793864766332326561767671796473336b7a653538646c716b756c79733872326b633873396d7030736d00";
        const babylonMessageTemplate = {
            "send": {
                "channel_id": parseInt(process.env.BABYLON_CHANNEL_ID || "4"),
                "timeout_height": "0",
                "instruction": process.env.BABYLON_INSTRUCTION || babylonInstructionDefault
            }
        };

        await sendBabylonToXionBridge(client, senderBabylonAddress, babylonContract, babylonMessageTemplate, babylonFunds);

    } catch (err) {
        logger.error(`[Babylon Runner] A critical error occurred: ${err.message}`);
        bufferReport(`🚨 Babylon Runner CRASHED: ${err.message.substring(0, 100)}...`);
    }
}


// --------------------------------------------------------------------------
// 7. MAIN EXECUTION LOGIC
// --------------------------------------------------------------------------
async function main() {
    // Skrip sekarang hanya menjalankan satu fungsi, jadi kita panggil langsung.
    // Ini akan berjalan dengan 'node bridge_script.js'
    await runBabylonToXionTransfer();

    await flushReport();
    logger.info("===== SCRIPT EXECUTION FINISHED =====");
}

main().catch(e => {
    logger.error(`Unhandled error in main execution: ${e.message}`);
    logger.error(e.stack);
    bufferReport(`🚨 CRITICAL ERROR in script: ${e.message}`);
    flushReport().finally(() => process.exit(1));
});
