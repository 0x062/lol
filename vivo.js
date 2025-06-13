// bridge_script.js (v4 - Babylon->Xion & Xion->SEI)

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
function bufferReport(text) { reportBuffer.push(text); }

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
async function pollUnionForPacketHash(txHash, chainName = "Chain", retries = 50, intervalMs = 6000) {
    // ... (Fungsi ini tidak berubah, tetap sama)
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
    logger.loading(`[UnionPoll-${chainName}] Polling for Packet Hash using ${submissionHash.substring(0, 15)}...`);
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
        }
        await delay(intervalMs);
    }
    logger.warn(`[UnionPoll-${chainName}] Could not retrieve Packet Hash for Tx: ${txHash}`);
    return null;
}


// --------------------------------------------------------------------------
// 5. BRIDGE FUNCTIONS
// --------------------------------------------------------------------------

// --- Fungsi generik untuk mengirim transaksi dari chain Cosmos ---
async function sendCosmosTransaction(
    chainName, client, senderAddress, contractAddress,
    messageTemplate, funds, gasPriceStr, gasLimit
) {
    let payload = JSON.parse(JSON.stringify(messageTemplate));
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    if (!payload.send) payload.send = {};
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    const fee = calculateFee(gasLimit, GasPrice.fromString(gasPriceStr));

    logger.loading(`[${chainName}] Sending ${funds[0].amount}${funds[0].denom} to contract ${contractAddress.substring(0,12)}...`);
    try {
        const result = await client.execute(
            senderAddress, contractAddress, payload, fee,
            `${chainName} bridge via JS Partner`, funds
        );
        const txHash = result.transactionHash;
        logger.success(`[${chainName}] Transaction sent! Hash: ${txHash}`);
        logger.info(`[${chainName}->Union] Attempting to poll Union for packet hash...`);
        
        const packetHash = await pollUnionForPacketHash(txHash, chainName);
        const reportMsg = `✅ ${chainName} Bridge (${funds[0].amount} ${funds[0].denom}) | Tx: \`${txHash.substring(0, 6)}...\``;

        if (packetHash) {
            bufferReport(`${reportMsg} | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
            bufferReport(`${reportMsg} | ⚠ Union Packet N/A`);
        }
    } catch (err) {
        logger.error(`[${chainName}] Transaction failed: ${err.message}`);
        if (err.message.includes("insufficient funds")) {
            logger.warn(`[${chainName}] Tip: Check if your wallet has enough funds for gas and transaction.`);
        }
        bufferReport(`❌ Failed ${chainName} Bridge: ${err.message.substring(0,100)}...`);
    }
}


// --------------------------------------------------------------------------
// 6. RUNNER FUNCTIONS
// --------------------------------------------------------------------------
async function runBabylonToXionTransfer() {
    logger.info("===== Starting Babylon -> Xion Transfer Process =====");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan!");
        bufferReport("❌ XION_MNEMONIC tidak ada di .env!");
        return;
    }

    const rpc = process.env.BABYLON_RPC_ENDPOINT;
    if (!rpc) {
        logger.error("BABYLON_RPC_ENDPOINT tidak ditemukan!");
        bufferReport("❌ BABYLON_RPC_ENDPOINT tidak ada di .env!");
        return;
    }
    
    // Konfigurasi Babylon
    const config = {
        chainName: "Babylon -> Xion",
        prefix: process.env.BABYLON_PREFIX || "bbn",
        contractAddress: process.env.BABYLON_CONTRACT_ADDRESS,
        minAmount: parseInt(process.env.BABYLON_TX_AMOUNT_MIN || "1000"),
        maxAmount: parseInt(process.env.BABYLON_TX_AMOUNT_MAX || "2000"),
        txDenom: process.env.BABYLON_TX_DENOM || "ubbn",
        gasPrice: process.env.BABYLON_GAS_PRICE || "0.01ubbn",
        gasLimit: parseInt(process.env.BABYLON_GAS_LIMIT || "700000"),
        channelId: parseInt(process.env.BABYLON_CHANNEL_ID),
        instruction: process.env.BABYLON_INSTRUCTION,
    };

    if (!config.instruction || !config.contractAddress || !config.channelId) {
        logger.error(`[Babylon] Konfigurasi (CONTRACT, INSTRUCTION, CHANNEL_ID) di .env belum lengkap!`);
        return;
    }

    try {
        logger.loading(`[Babylon] Preparing wallet with prefix '${config.prefix}'...`);
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: config.prefix });
        const [firstAccount] = await wallet.getAccounts();
        const senderAddress = firstAccount.address;
        logger.info(`[Babylon] Wallet Address: ${senderAddress}`);

        logger.loading(`[Babylon] Connecting to RPC to check balance...`);
        const client = await SigningCosmWasmClient.connectWithSigner(rpc, wallet);
        const balance = await client.getBalance(senderAddress, config.txDenom);
        logger.info(`[Babylon] Current balance: ${balance.amount} ${balance.denom}`);

        const amountToSend = getRandomAmount(config.minAmount, config.maxAmount);
        if (BigInt(balance.amount) < BigInt(amountToSend)) {
            logger.error(`[Babylon] Insufficient funds. Needed: ${amountToSend}, Have: ${balance.amount}`);
            bufferReport(`❌ ${config.chainName}: Saldo tidak cukup (Butuh: ${amountToSend}, Punya: ${balance.amount})`);
            return;
        }

        const funds = [coin(amountToSend.toString(), config.txDenom)];
        const messageTemplate = {
            "send": { "channel_id": config.channelId, "timeout_height": "0", "instruction": config.instruction }
        };

        await sendCosmosTransaction("Babylon", client, senderAddress, config.contractAddress, messageTemplate, funds, config.gasPrice, config.gasLimit);

    } catch (err) {
        logger.error(`[Babylon Runner] A critical error occurred: ${err.message}`);
        bufferReport(`🚨 Babylon Runner CRASHED: ${err.message.substring(0, 100)}...`);
    }
}

// --- GANTI FUNGSI LAMA DENGAN YANG BARU INI ---
async function runXionToSeiTransfer() {
    logger.info("===== Starting Xion -> SEI Transfer Process =====");
    const mnemonic = process.env.XION_MNEMONIC;
    if (!mnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan!");
        bufferReport("❌ XION_MNEMONIC tidak ada di .env!");
        return;
    }

    const rpc = process.env.XION_SEI_RPC_ENDPOINT;
    if (!rpc) {
        logger.error("XION_SEI_RPC_ENDPOINT tidak ditemukan!");
        bufferReport("❌ XION_SEI_RPC_ENDPOINT tidak ada di .env!");
        return;
    }
    
    const config = {
        chainName: "Xion -> SEI",
        prefix: process.env.XION_SEI_PREFIX || "xion",
        contractAddress: process.env.XION_SEI_CONTRACT_ADDRESS,
        minAmount: parseInt(process.env.XION_SEI_TX_AMOUNT_MIN || "10000"),
        maxAmount: parseInt(process.env.XION_SEI_TX_AMOUNT_MAX || "15000"),
        txDenom: process.env.XION_SEI_TX_DENOM || "uxion",
        gasPrice: process.env.XION_SEI_GAS_PRICE || "0.025uxion",
        gasLimit: parseInt(process.env.XION_SEI_GAS_LIMIT || "700000"),
        channelId: parseInt(process.env.XION_SEI_CHANNEL_ID),
        instruction: process.env.XION_SEI_INSTRUCTION,
    };

    // --- [BAGIAN DEBUG TAMBAHAN] ---
    logger.warn("----------- DEBUGGING INSTRUCTION -----------");
    console.log("Value:", config.instruction); // Mencetak nilainya
    console.log("Length:", config.instruction ? config.instruction.length : "Not Found"); // Mencetak panjangnya
    logger.warn("-------------------------------------------");
    // --- [AKHIR BAGIAN DEBUG] ---

    if (!config.instruction || !config.contractAddress || !config.channelId) {
        logger.error(`[Xion->SEI] Konfigurasi (CONTRACT, INSTRUCTION, CHANNEL_ID) di .env belum lengkap!`);
        return;
    }

    try {
        logger.loading(`[Xion] Preparing wallet with prefix '${config.prefix}'...`);
        const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: config.prefix });
        const [firstAccount] = await wallet.getAccounts();
        const senderAddress = firstAccount.address;
        logger.info(`[Xion] Wallet Address: ${senderAddress}`);

        logger.loading(`[Xion] Connecting to RPC to check balance...`);
        const client = await SigningCosmWasmClient.connectWithSigner(rpc, wallet);
        const balance = await client.getBalance(senderAddress, config.txDenom);
        logger.info(`[Xion] Current balance: ${balance.amount} ${balance.denom}`);

        const amountToSend = getRandomAmount(config.minAmount, config.maxAmount);
        if (BigInt(balance.amount) < BigInt(amountToSend)) {
            logger.error(`[Xion] Insufficient funds. Needed: ${amountToSend}, Have: ${balance.amount}`);
            bufferReport(`❌ ${config.chainName}: Saldo tidak cukup (Butuh: ${amountToSend}, Punya: ${balance.amount})`);
            return;
        }

        const funds = [coin(amountToSend.toString(), config.txDenom)];
        const messageTemplate = {
            "send": { "channel_id": config.channelId, "timeout_height": "0", "instruction": config.instruction }
        };

        await sendCosmosTransaction("Xion", client, senderAddress, config.contractAddress, messageTemplate, funds, config.gasPrice, config.gasLimit);

    } catch (err) {
        logger.error(`[Xion->SEI Runner] A critical error occurred: ${err.message}`);
        bufferReport(`🚨 Xion->SEI Runner CRASHED: ${err.message.substring(0, 100)}...`);
    }
}


// --------------------------------------------------------------------------
// 7. MAIN EXECUTION LOGIC --- [MODIFIKASI] ---
// --------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    const transferType = args[0];

    if (transferType === 'babylon') {
        await runBabylonToXionTransfer();
    } else if (transferType === 'sei') {
        await runXionToSeiTransfer();
    } else if (!transferType) {
        logger.info("===== RUNNING ALL TRANSFERS SEQUENTIALLY (Babylon then SEI) =====");
        
        await runBabylonToXionTransfer();
        
        logger.info("Waiting for 10 seconds before next transfer...");
        await delay(10000); 
        
        await runXionToSeiTransfer();

    } else {
        logger.warn("--------------------------------------------------------------------------------");
        logger.warn(`Invalid transfer type specified: '${transferType}'.`);
        logger.warn("Gunakan: node bridge_script.js babylon   (untuk Babylon -> Xion)");
        logger.warn("ATAU   : node bridge_script.js sei      (untuk Xion -> SEI)");
        logger.warn("ATAU   : biarkan kosong untuk menjalankan keduanya secara berurutan.");
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
