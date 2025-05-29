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
// 2. TELEGRAM REPORTER (Anda perlu membuat file ini: telegramReporter.js)
// --------------------------------------------------------------------------
/* Contoh isi telegramReporter.js:
const axios = require('axios');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendReport(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("[Telegram] Bot token or chat ID not configured. Logging to console instead.");
        console.log("--- TELEGRAM REPORT (SIMULASI) ---\n" + message + "\n----------------------------------");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`[Telegram] Failed to send report: ${error.message}`);
    }
}
module.exports = { sendReport };
*/
const { sendReport } = require('./telegramReporter'); // Pastikan file ini ada

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

// --------------------------------------------------------------------------
// 4. POLLING FUNCTION (UNION BUILD)
// --------------------------------------------------------------------------
async function pollUnionForPacketHash(txHash, chainName = "Xion", retries = 50, intervalMs = 6000) {
    const POLLING_URL = process.env.UNION_POLLING_URL || "https://graphql.union.build/v1/graphql";
    const HEADERS = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://app.union.build',
        'Referer': 'https://app.union.build/',
    };
    const submissionHash = '0x' + txHash.toLowerCase(); // Cosmos TX hashes are uppercase, Union might expect lowercase w/ 0x
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
            const res = await axios.post(POLLING_URL, data, { headers: HEADERS, timeout: 10000 }); // Added timeout
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
            // Retry on network errors or server-side issues
            if (!e.response || e.code === 'ECONNABORTED' || e.response?.status >= 500) {
                 logger.warn(`[UnionPoll-${chainName}] Retrying after network/server error...`);
            }
            // For other errors (like 4xx), it might still retry, or you could choose to break.
        }
        await delay(intervalMs);
    }
    logger.warn(`[UnionPoll-${chainName}] Could not retrieve Packet Hash after ${retries} retries for Tx: ${txHash}`);
    return null;
}

// --------------------------------------------------------------------------
// 5. BRIDGE FUNCTIONS
// --------------------------------------------------------------------------

// ------- 5.1 XION -> HOLESKY -------
async function sendToXionBridge(
    mnemonic,
    xionRpcEndpoint,
    bridgeContractAddress,
    messageTemplate, // This is the { send: { ... } } object
    funds           // This is an array of Coin objects, e.g., [coin("10000", "uxion")]
) {
    const XION_PREFIX = process.env.XION_PREFIX || "xion";
    const XION_GAS_PRICE_STR = process.env.XION_GAS_PRICE || "0.025uxion";
    const XION_GAS_LIMIT = parseInt(process.env.XION_GAS_LIMIT || "700000");

    logger.loading(`[Xion] Preparing wallet with prefix '${XION_PREFIX}'...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: XION_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderXionAddress = firstAccount.address;
    logger.info(`[Xion] Wallet Address: ${senderXionAddress}`);

    logger.loading(`[Xion] Connecting to RPC (${xionRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(xionRpcEndpoint, wallet);

    let payload = JSON.parse(JSON.stringify(messageTemplate)); // Deep clone
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    // Ensure the 'send' object exists before trying to set properties on it
    if (!payload.send) payload.send = {};
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    const fee = calculateFee(XION_GAS_LIMIT, GasPrice.fromString(XION_GAS_PRICE_STR));

    logger.loading(`[Xion] Sending message to contract ${bridgeContractAddress}...`);
    try {
        const result = await client.execute(
            senderXionAddress,
            bridgeContractAddress,
            payload, // This is the 'msg' object for the contract
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
    messagePayloadTemplate, // This is the { send: { ... } } object
    fundsForTx              // This is an array of Coin objects, e.g., [coin("1000", "ubbn")]
) {
    const BABYLON_PREFIX = process.env.BABYLON_PREFIX || "bbn";
    const BABYLON_GAS_PRICE_STR = process.env.BABYLON_GAS_PRICE || "0.01ubbn"; // Adjust if needed
    const BABYLON_GAS_LIMIT = parseInt(process.env.BABYLON_GAS_LIMIT || "700000");

    logger.loading(`[Babylon] Preparing wallet with prefix '${BABYLON_PREFIX}'...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: BABYLON_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderBabylonAddress = firstAccount.address;
    logger.info(`[Babylon] Wallet Address: ${senderBabylonAddress}`);

    logger.loading(`[Babylon] Connecting to RPC (${babylonRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(babylonRpcEndpoint, wallet);

    let payload = JSON.parse(JSON.stringify(messagePayloadTemplate)); // Deep clone
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    // Ensure the 'send' object exists
    if (!payload.send) payload.send = {};
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');
    // timeout_height should already be in messagePayloadTemplate from the runner function

    const fee = calculateFee(BABYLON_GAS_LIMIT, GasPrice.fromString(BABYLON_GAS_PRICE_STR));

    logger.loading(`[Babylon] Sending message to contract ${babylonContractAddress}...`);
    try {
        const result = await client.execute(
            senderBabylonAddress,
            babylonContractAddress,
            payload, // This is the 'msg' object for the contract
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
// 6. RUNNER FUNCTIONS
// --------------------------------------------------------------------------

async function runXionToHoleskyTransfer() {
    logger.info("Starting Xion -> Holesky Transfer Process...");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan di .env!");
        bufferReport("❌ XION_MNEMONIC tidak ada di .env!");
        return;
    }

    const xionRpc = process.env.XION_RPC_ENDPOINT || "https://rpc.xion-testnet-2.burnt.com"; // From your initial script
    const xionBridgeContract = process.env.XION_BRIDGE_CONTRACT || "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; // From your initial script
    
    // Default instruction string for Xion
    const xionInstructionDefault = "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf800000000000000000000000000000000000000000000000000000000000000000000000000000000000000057578696f6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000458494f4e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000478696f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001407D878ab885453DcB2baa987E6761C86b5f45F27000000000000000000000000";
    
    const xionMessageTemplate = {
        "send": {
            "channel_id": parseInt(process.env.XION_CHANNEL_ID || "1"),
            "timeout_height": "0", // Crucial for Xion contract, as per original structure
            "instruction": process.env.XION_INSTRUCTION || xionInstructionDefault
            // timeout_timestamp and salt are added dynamically in sendToXionBridge
        }
    };
    const xionFunds = [coin(process.env.XION_TX_AMOUNT || "10000", process.env.XION_TX_DENOM || "uxion")];

    await sendToXionBridge(mnemonic, xionRpc, xionBridgeContract, xionMessageTemplate, xionFunds);
}

async function runBabylonToXionTransfer() {
    logger.info("Starting Babylon -> Xion Transfer Process...");
    const mnemonic = process.env.XION_MNEMONIC; // Assuming same mnemonic
    if (!mnemonic) {
        logger.error("XION_MNEMONIC (untuk Babylon) tidak ditemukan di .env!");
        bufferReport("❌ MNEMONIC (untuk Babylon) tidak ada di .env!");
        return; // Stop if no mnemonic
    }

    const babylonRpc = process.env.BABYLON_RPC_ENDPOINT;
    if (!babylonRpc) {
        logger.error("BABYLON_RPC_ENDPOINT tidak ditemukan di .env! Anda perlu mengisinya.");
        bufferReport("❌ BABYLON_RPC_ENDPOINT tidak ada di .env!");
        return; // Stop if Babylon RPC is not set
    }
    
    // Default values from your provided JSON
    const babylonContract = process.env.BABYLON_CONTRACT_ADDRESS || "bbn1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292q77945h";
    const babylonChannelId = process.env.BABYLON_CHANNEL_ID || "4";
    // Default instruction string for Babylon from your JSON
    const babylonInstructionDefault = "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002800000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002a62626e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396365376576656e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000047562626e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003f78696f6e316a30687036717a7467617a6137743079386476633232656176767671796473336b7a653538646c716b756c79733872326b633873396d7030736d00";
    
    const babylonTxAmount = process.env.BABYLON_TX_AMOUNT || "1000"; // From your JSON
    const babylonTxDenom = process.env.BABYLON_TX_DENOM || "ubbn";   // From your JSON

    // ** INI BAGIAN PENTING YANG DIPERBAIKI **
    const babylonMessageTemplate = {
        "send": {
            "channel_id": parseInt(babylonChannelId),
            "timeout_height": "0", // <====== DIPASTIKAN ADA DI SINI
            "instruction": process.env.BABYLON_INSTRUCTION || babylonInstructionDefault
            // timeout_timestamp dan salt akan diisi secara dinamis di sendBabylonToXionBridge
        }
    };
    const babylonFunds = [coin(babylonTxAmount, babylonTxDenom)];

    if (!babylonInstructionDefault || babylonInstructionDefault.length < 100) { // Simple validation
        logger.error("BABYLON_INSTRUCTION (default) tidak valid atau terlalu pendek!");
        return;
    }

    await sendBabylonToXionBridge(mnemonic, babylonRpc, babylonContract, babylonMessageTemplate, babylonFunds);
}


// --------------------------------------------------------------------------
// 7. MAIN EXECUTION LOGIC
// --------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    const transferType = args[0];

    if (transferType === 'xion') {
        logger.info("===== RUNNING XION -> HOLESKY TRANSFER (via CLI argument) =====");
        await runXionToHoleskyTransfer();
    } else if (transferType === 'babylon') {
        logger.info("===== RUNNING BABYLON -> XION TRANSFER (via CLI argument) =====");
        await runBabylonToXionTransfer();
    } else if (!transferType) {
        logger.info("===== No CLI argument. RUNNING ALL TRANSFERS SEQUENTIALLY (Xion then Babylon) by default. =====");
        
        logger.info("--- Starting Xion -> Holesky Transfer ---");
        await runXionToHoleskyTransfer();
        logger.info("--- Xion -> Holesky Transfer Attempt Finished ---");
        
        logger.info("Waiting for 5 seconds before starting next transfer type...");
        await delay(5000); 
        
        logger.info("--- Starting Babylon -> Xion Transfer ---");
        await runBabylonToXionTransfer();
        logger.info("--- Babylon -> Xion Transfer Attempt Finished ---");

    } else {
        logger.warn("--------------------------------------------------------------------------------");
        logger.warn(`Invalid transfer type specified: '${transferType}'.`);
        logger.warn("Use: node bridge_script.js xion");
        logger.warn("OR   node bridge_script.js babylon");
        logger.warn("OR   leave blank (no arguments) to run both Xion->Holesky and then Babylon->Xion transfers sequentially.");
        logger.warn("--------------------------------------------------------------------------------");
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
