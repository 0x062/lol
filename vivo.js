// bridge_script.js

// --------------------------------------------------------------------------
// 1. IMPORTS
// --------------------------------------------------------------------------
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { calculateFee, GasPrice, coin } = require("@cosmjs/stargate");
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config(); // Memuat variabel dari .env

// --------------------------------------------------------------------------
// 2. TELEGRAM REPORTER (Anda perlu membuat file ini)
// --------------------------------------------------------------------------
// Buat file telegramReporter.js di direktori yang sama
// (Lihat contoh implementasi di respons saya sebelumnya)
const { sendReport } = require('./telegramReporter');

// --------------------------------------------------------------------------
// 3. HELPER FUNCTIONS (Sama seperti sebelumnya)
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

// --------------------------------------------------------------------------
// 4. POLLING FUNCTION (UNION BUILD) (Sama seperti sebelumnya)
// --------------------------------------------------------------------------
async function pollUnionForPacketHash(txHash, chainName = "Xion", retries = 50, intervalMs = 6000) {
    const POLLING_URL = process.env.UNION_POLLING_URL || "https://graphql.union.build/v1/graphql";
    const HEADERS = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://app.union.build',
        'Referer': 'https://app.union.build/',
    };
    const submissionHash = '0x' + txHash.toLowerCase();
    const data = {
        query: `
            query GetPacketHashBySubmissionTxHash($submission_tx_hash: String!) {
              v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {
                packet_hash
              }
            }
        `,
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
// 5. BRIDGE FUNCTIONS (Sama seperti sebelumnya, dengan konstanta prefix & gas di dalam fungsi)
// --------------------------------------------------------------------------

// ------- 5.1 XION -> HOLESKY -------
async function sendToXionBridge(
    mnemonic,
    xionRpcEndpoint,
    bridgeContractAddress,
    messageTemplate,
    funds
) {
    const XION_PREFIX = process.env.XION_PREFIX || "xion";
    const XION_GAS_PRICE_STR = process.env.XION_GAS_PRICE || "0.025uxion";
    const XION_GAS_LIMIT = parseInt(process.env.XION_GAS_LIMIT || "700000");

    // (Logika internal fungsi sama seperti respons sebelumnya)
    logger.loading(`[Xion] Preparing wallet with prefix '${XION_PREFIX}'...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: XION_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderXionAddress = firstAccount.address;
    logger.info(`[Xion] Wallet Address: ${senderXionAddress}`);

    logger.loading(`[Xion] Connecting to RPC (${xionRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(xionRpcEndpoint, wallet);

    let payload = JSON.parse(JSON.stringify(messageTemplate));
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    const fee = calculateFee(XION_GAS_LIMIT, GasPrice.fromString(XION_GAS_PRICE_STR));

    logger.loading(`[Xion] Sending message to contract ${bridgeContractAddress}...`);
    try {
        const result = await client.execute(
            senderXionAddress,
            bridgeContractAddress,
            payload,
            fee,
            "Xion to Holesky via JS Partner (24h timeout)",
            funds
        );
        const xionTxHash = result.transactionHash;
        logger.success(`[Xion] Transaction sent! Hash: ${xionTxHash}`);
        logger.info(`[Xion->Union] Attempting to poll Union for packet hash using Xion Tx Hash: ${xionTxHash}`);
        const packetHash = await pollUnionForPacketHash(xionTxHash, "Xion");
        if (packetHash) {
            bufferReport(`✅ Xion -> Holesky | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
            bufferReport(`✅ Xion -> Holesky | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | ⚠ Union Packet N/A`);
        }
    } catch (err) {
        logger.error(`[Xion] Transaction failed: ${err.message}`);
        bufferReport(`❌ Failed Xion -> Holesky: ${err.message.substring(0,100)}...`);
    }
}

// ------- 5.2 BABYLON -> XION -------
async function sendBabylonToXionBridge(
    mnemonic,
    babylonRpcEndpoint,
    babylonContractAddress,
    messagePayloadTemplate,
    fundsForTx
) {
    const BABYLON_PREFIX = process.env.BABYLON_PREFIX || "bbn"; // Diambil dari JSON Anda
    const BABYLON_GAS_PRICE_STR = process.env.BABYLON_GAS_PRICE || "0.01ubbn"; // Perkiraan, sesuaikan!
    const BABYLON_GAS_LIMIT = parseInt(process.env.BABYLON_GAS_LIMIT || "700000");

    // (Logika internal fungsi sama seperti respons sebelumnya)
    logger.loading(`[Babylon] Preparing wallet with prefix '${BABYLON_PREFIX}'...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: BABYLON_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderBabylonAddress = firstAccount.address;
    logger.info(`[Babylon] Wallet Address: ${senderBabylonAddress}`);

    logger.loading(`[Babylon] Connecting to RPC (${babylonRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(babylonRpcEndpoint, wallet);

    let payload = JSON.parse(JSON.stringify(messagePayloadTemplate));
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    const fee = calculateFee(BABYLON_GAS_LIMIT, GasPrice.fromString(BABYLON_GAS_PRICE_STR));

    logger.loading(`[Babylon] Sending message to contract ${babylonContractAddress}...`);
    try {
        const result = await client.execute(
            senderBabylonAddress,
            babylonContractAddress,
            payload,
            fee,
            "Babylon to Xion Bridge via JS Partner",
            fundsForTx
        );
        const babylonTxHash = result.transactionHash;
        logger.success(`[Babylon] Transaction sent! Hash: ${babylonTxHash}`);
        logger.info(`[Babylon->Union] Attempting to poll Union for packet hash using Babylon Tx Hash: ${babylonTxHash}`);
        const packetHash = await pollUnionForPacketHash(babylonTxHash, "Babylon");
        if (packetHash) {
            bufferReport(`✅ Babylon -> Xion | Babylon Tx: \`${babylonTxHash.substring(0, 6)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
            bufferReport(`✅ Babylon -> Xion | Babylon Tx: \`${babylonTxHash.substring(0, 6)}...\` | ⚠ Union Packet N/A`);
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
// 6. RUNNER FUNCTIONS (Dengan nilai default dari data Anda)
// --------------------------------------------------------------------------

async function runXionToHoleskyTransfer() {
    logger.info("Starting Xion -> Holesky Transfer Process...");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan di .env!");
        bufferReport("❌ XION_MNEMONIC tidak ada di .env!");
        return;
    }

    // Nilai default diambil dari skrip awal Anda
    const xionRpc = process.env.XION_RPC_ENDPOINT || "https://rpc.xion-testnet-2.burnt.com";
    const xionBridgeContract = process.env.XION_BRIDGE_CONTRACT || "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9";
    
    const xionInstructionDefault = "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf800000000000000000000000000000000000000000000000000000000000000000000000000000000000000057578696f6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000458494f4e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000478696f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001407D878ab885453DcB2baa987E6761C86b5f45F27000000000000000000000000";
    const xionMessageTemplate = {
        "send": {
            "channel_id": parseInt(process.env.XION_CHANNEL_ID || "1"),
            "timeout_height": "0",
            "instruction": process.env.XION_INSTRUCTION || xionInstructionDefault
        }
    };
    const xionFunds = [coin(process.env.XION_TX_AMOUNT || "10000", process.env.XION_TX_DENOM || "uxion")];

    await sendToXionBridge(mnemonic, xionRpc, xionBridgeContract, xionMessageTemplate, xionFunds);
}

async function runBabylonToXionTransfer() {
    logger.info("Starting Babylon -> Xion Transfer Process...");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC (untuk Babylon) tidak ditemukan di .env!");
        bufferReport("❌ MNEMONIC (untuk Babylon) tidak ada di .env!");
        return;
    }

    // Anda akan mengisi BABYLON_RPC_ENDPOINT di .env
    const babylonRpc = process.env.BABYLON_RPC_ENDPOINT;
    // Nilai default diambil dari JSON yang Anda berikan
    const babylonContract = process.env.BABYLON_CONTRACT_ADDRESS || "bbn1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292q77945h";
    const babylonChannelId = process.env.BABYLON_CHANNEL_ID || "4"; // Dari JSON Anda
    const babylonInstructionDefault = "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002a62626e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396365376576656e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003f78696f6e316a30687036717a7467617a6137743079386476633232656176767671796473336b7a653538646c716b756c79733872326b633873396d7030736d00"; // Dari JSON Anda
    const babylonTxAmount = process.env.BABYLON_TX_AMOUNT || "1000"; // Dari JSON Anda
    const babylonTxDenom = process.env.BABYLON_TX_DENOM || "ubbn"; // Dari JSON Anda

    if (!babylonRpc) { // Hanya cek babylonRpc karena yang lain ada default
        logger.error("BABYLON_RPC_ENDPOINT tidak ditemukan di .env! Anda perlu mengisinya.");
        bufferReport("❌ BABYLON_RPC_ENDPOINT tidak ada di .env!");
        return;
    }
    if (!babylonInstructionDefault || babylonInstructionDefault.length < 100) { // Validasi sederhana
        logger.error("BABYLON_INSTRUCTION tidak valid atau terlalu pendek!");
        return;
    }

    const babylonMessageTemplate = {
        "send": {
            "channel_id": parseInt(babylonChannelId),
            "instruction": process.env.BABYLON_INSTRUCTION || babylonInstructionDefault
        }
    };
    const babylonFunds = [coin(babylonTxAmount, babylonTxDenom)];

    await sendBabylonToXionBridge(mnemonic, babylonRpc, babylonContract, babylonMessageTemplate, babylonFunds);
}

// --------------------------------------------------------------------------
// 7. MAIN EXECUTION LOGIC (Sama seperti sebelumnya)
// --------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    let transferType = args[0];

    if (!transferType && process.env.DEFAULT_TRANSFER_TYPE) {
        logger.info(`No transfer type specified, using DEFAULT_TRANSFER_TYPE from .env: ${process.env.DEFAULT_TRANSFER_TYPE}`);
        transferType = process.env.DEFAULT_TRANSFER_TYPE;
    }

    if (transferType === 'xion') {
        logger.info("===== RUNNING XION -> HOLESKY TRANSFER =====");
        await runXionToHoleskyTransfer();
    } else if (transferType === 'babylon') {
        logger.info("===== RUNNING BABYLON -> XION TRANSFER =====");
        await runBabylonToXionTransfer();
    } else {
        logger.warn("--------------------------------------------------------------------------------");
        logger.warn("No valid transfer type specified or DEFAULT_TRANSFER_TYPE not set.");
        logger.warn("Use: node bridge_script.js xion");
        logger.warn("OR   node bridge_script.js babylon");
        logger.warn("OR   Set DEFAULT_TRANSFER_TYPE=xion (atau babylon) di .env");
        logger.warn("--------------------------------------------------------------------------------");
        return;
    }
    await flushReport();
    logger.info("===== SCRIPT EXECUTION FINISHED =====");
}

main().catch(e => {
    logger.error(`Unhandled error in main execution: ${e.message}`);
    logger.error(e.stack);
    bufferReport(`🚨 CRITICAL ERROR in script: ${e.message}`);
    flushReport().finally(() => process.exit(1));
});
