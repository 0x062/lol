// holesky_usdc_to_xion.js

// --------------------------------------------------------------------------
// 1. IMPORTS
// --------------------------------------------------------------------------
const { ethers } = require("ethers");
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

// --------------------------------------------------------------------------
// 2. TELEGRAM REPORTER (Opsional, siapkan telegramReporter.js jika ingin dipakai)
// --------------------------------------------------------------------------
// Inisialisasi dummy sendReport jika file tidak ada, agar skrip tidak error
let sendReport = async (message) => {
    console.warn("[Telegram] telegramReporter.js not fully implemented or found. Logging to console instead.");
    console.log("--- TELEGRAM REPORT (SIMULASI) ---\n" + message + "\n----------------------------------");
};
try {
    const reporter = require('./telegramReporter'); // Jika kamu punya file ini
    if (reporter && typeof reporter.sendReport === 'function') {
        sendReport = reporter.sendReport;
    }
} catch (e) {
    // Biarkan menggunakan dummy jika require gagal
}

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

// --------------------------------------------------------------------------
// 4. POLLING FUNCTION (UNION BUILD)
// --------------------------------------------------------------------------
async function pollUnionForPacketHash(txHash, chainName = "HoleskyComplex", retries = 50, intervalMs = 6000) {
    const POLLING_URL = process.env.UNION_POLLING_URL || "https://graphql.union.build/v1/graphql";
    const HEADERS = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://app.union.build',
        'Referer': 'https://app.union.build/',
    };
    const submissionHash = txHash.startsWith('0x') ? txHash.toLowerCase() : '0x' + txHash.toLowerCase();
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

// File: holesky_usdc_to_xion.js
// ... (bagian import, helper, pollUnionForPacketHash tetap sama) ...

// --------------------------------------------------------------------------
// 5. BRIDGE FUNCTION: HOLESKY (EVM) -> XION (COSMOS) - Versi Fungsi Send Kompleks
// --------------------------------------------------------------------------
async function sendHoleskyToXionBridge_Complex(
    holeskyRpcEndpoint,
    holeskyPrivateKey,
    holeskyBridgeContractAddress, // Alamat kontrak yang memiliki fungsi send(...) kompleks ini
    usdcTokenAddress, // Alamat kontrak token USDC di Holesky
    usdcAmountToBridge, // Jumlah USDC dalam unit terkecil (string)
    param_uint32_1, 
    param_uint64_2_timeoutHeight, 
    param_tuple_uint8_1, 
    param_tuple_uint8_2, 
    instructionBytesPayload, 
    gasLimitHolesky
) {
    logger.loading(`[HoleskyComplex] Initializing Holesky provider and wallet...`);
    if (!holeskyRpcEndpoint || !holeskyPrivateKey || !holeskyBridgeContractAddress || !usdcTokenAddress || !usdcAmountToBridge) {
        logger.error(`[HoleskyComplex] Missing required config: RPC, Private Key, Bridge Address, USDC Address, or USDC Amount.`);
        await sendReport(`❌ Failed HoleskyComplex -> Xion: Missing Holesky configuration.`);
        return null;
    }
    if (parseFloat(usdcAmountToBridge) <= 0) {
        logger.error(`[HoleskyComplex] USDC amount to bridge must be greater than 0.`);
        await sendReport(`❌ Failed HoleskyComplex -> Xion: Invalid USDC amount.`);
        return null;
    }

    const provider = new ethers.providers.JsonRpcProvider(holeskyRpcEndpoint);
    const wallet = new ethers.Wallet(holeskyPrivateKey, provider);
    logger.info(`[HoleskyComplex] Wallet Address: ${wallet.address}`);

    const complexBridgeAbi = [
        "function send(uint32 destDomain, uint64 timeoutHeight, uint64 timeoutTimestamp, bytes32 salt, tuple(uint8, uint8, bytes) instruction) payable returns (bytes32 messageId)"
    ];
    const erc20Abi = [
        "function approve(address spender, uint256 amount) public returns (bool)",
        "function allowance(address owner, address spender) public view returns (uint256)"
    ];

    const bridgeContract = new ethers.Contract(holeskyBridgeContractAddress, complexBridgeAbi, wallet);
    const tokenContract = new ethers.Contract(usdcTokenAddress, erc20Abi, wallet);

    let tx; // Deklarasikan tx di sini agar bisa diakses di blok catch jika perlu
    try {
        logger.loading(`[HoleskyComplex] Approving ${usdcAmountToBridge} USDC (${usdcTokenAddress}) for bridge contract ${holeskyBridgeContractAddress}...`);
        const currentAllowance = await tokenContract.allowance(wallet.address, holeskyBridgeContractAddress);
        logger.info(`[HoleskyComplex] Current USDC allowance: ${currentAllowance.toString()}`);

        if (currentAllowance.lt(ethers.BigNumber.from(usdcAmountToBridge))) {
            const approveTx = await tokenContract.approve(holeskyBridgeContractAddress, ethers.BigNumber.from(usdcAmountToBridge), { gasLimit: 100000 });
            logger.loading(`[HoleskyComplex] Approval transaction sent: ${approveTx.hash}. Waiting for confirmation...`);
            await approveTx.wait();
            logger.success(`[HoleskyComplex] USDC token approved successfully.`);
        } else {
            logger.info(`[HoleskyComplex] Sufficient USDC allowance already present.`);
        }

        const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
        const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
        const timeoutTimestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
        const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));

        const instructionTuple = [
            parseInt(param_tuple_uint8_1, 10),
            parseInt(param_tuple_uint8_2, 10),
            instructionBytesPayload
        ];

        logger.loading(`[HoleskyComplex] Sending message to bridge contract ${holeskyBridgeContractAddress}...`);
        logger.info(`[HoleskyComplex] Params for send: destDomain=${param_uint32_1}, timeoutHeight=${param_uint64_2_timeoutHeight}, timeoutTimestamp=${timeoutTimestamp}, salt=${salt.substring(0,15)}...`);
        logger.info(`[HoleskyComplex] Instruction Tuple: [${instructionTuple[0]}, ${instructionTuple[1]}, ${instructionTuple[2].substring(0,40)}...]`);
        
        const transactionOptions = { gasLimit: gasLimitHolesky };
        
        tx = await bridgeContract.send( // Assign ke tx yang dideklarasikan di luar try
            parseInt(param_uint32_1, 10),
            ethers.BigNumber.from(param_uint64_2_timeoutHeight),
            ethers.BigNumber.from(timeoutTimestamp),
            salt,
            instructionTuple,
            transactionOptions
        );

        logger.loading(`[HoleskyComplex] Transaction sent: ${tx.hash}. Waiting for confirmation...`); // tx.hash sudah ada di sini
        const receipt = await tx.wait(); // Tunggu konfirmasi
        
        // Periksa status transaksi dari receipt
        if (receipt.status === 0) {
            logger.error(`[HoleskyComplex] Transaction failed on-chain (reverted). TxHash: ${tx.hash}`);
            await sendReport(`❌ Failed HoleskyComplex -> Xion: Transaction ${tx.hash.substring(0,10)}... reverted.`);
            return null; // Keluar jika transaksi revert
        }

        logger.success(`[HoleskyComplex] Transaction confirmed! Block: ${receipt.blockNumber}, TxHash: ${tx.hash}`);
        
        // === PERBAIKAN: Gunakan tx.hash yang sudah pasti ada ===
        const holeskyTxHash = tx.hash; 
        // =======================================================

        logger.info(`[HoleskyComplex->Union] Polling Union for packet hash using Holesky Tx Hash: ${holeskyTxHash}`);
        const packetHash = await pollUnionForPacketHash(holeskyTxHash, "HoleskyComplex");

        if (packetHash) {
            await sendReport(`✅ HoleskyComplex (0.01 USDC) -> Xion | Holesky Tx: \`${holeskyTxHash.substring(0, 10)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
            logger.success(`[HoleskyComplex->Xion] Packet hash received: ${packetHash}. Further Xion interaction needed.`);
            // !!! TODO: KIRIM PESAN KE KONTRAK XION UNTUK MENYELESAIKAN BRIDGE !!!
            return { holeskyTxHash, packetHash };
        } else {
            await sendReport(`✅ HoleskyComplex (0.01 USDC) -> Xion | Holesky Tx: \`${holeskyTxHash.substring(0, 10)}...\` | ⚠ Union Packet N/A`);
            logger.warn(`[HoleskyComplex->Union] Could not retrieve packet hash from Union.build.`);
            return { holeskyTxHash, packetHash: null };
        }

    } catch (err) {
        logger.error(`[HoleskyComplex] Transaction failed: ${err.message}`);
        let detailedErrorMessage = err.message;
        if (err.code === ethers.utils.Logger.errors.CALL_EXCEPTION) {
            logger.error(`[HoleskyComplex] Call exception: ${err.reason}`);
            detailedErrorMessage = err.reason || err.message;
            if (err.transaction) {
                 logger.error(`[HoleskyComplex] TX Data: ${JSON.stringify(err.transaction)}`);
            }
        } else if (err.data && typeof err.data === 'string') {
             logger.error(`[HoleskyComplex] Error data: ${err.data}`);
             detailedErrorMessage += ` | Data: ${err.data}`;
        } else if (err.error && err.error.data && err.error.data.message) {
            logger.error(`[HoleskyComplex] Full error: ${err.error.data.message}`);
            detailedErrorMessage = err.error.data.message;
        }
        // Jika transaksi sudah terkirim (tx.hash ada) tapi error terjadi setelahnya (misal saat tx.wait())
        const failedTxHash = tx ? tx.hash : (err.transactionHash || "N/A");
        logger.error(`[HoleskyComplex] Failed Tx Hash: ${failedTxHash}`);
        
        await sendReport(`❌ Failed HoleskyComplex (0.01 USDC) -> Xion: ${detailedErrorMessage.substring(0, 150)}... Tx: ${failedTxHash.substring(0,10)}`);
        return null;
    }
}

// ... (fungsi runHoleskyToXionTransfer, main, dan .catch() tetap sama) ...
    
// --------------------------------------------------------------------------
// 6. RUNNER FUNCTION
// --------------------------------------------------------------------------
async function runHoleskyToXionTransfer() {
    logger.info("Starting Holesky (0.01 USDC - Complex Send) -> Xion Transfer Process...");

    // Variabel dari .env
    const holeskyRpc = process.env.HOLESKY_RPC_ENDPOINT;
    const holeskyKey = process.env.HOLESKY_PRIVATE_KEY;
    const holeskyBridgeAddr = process.env.HOLESKY_BRIDGE_CONTRACT_ADDRESS;
    const usdcTokenAddr = process.env.HOLESKY_USDC_TOKEN_ADDRESS;

    if (!holeskyRpc || !holeskyKey || !holeskyBridgeAddr || !usdcTokenAddr) {
        logger.error("Konfigurasi Holesky (HOLESKY_RPC_ENDPOINT, HOLESKY_PRIVATE_KEY, HOLESKY_BRIDGE_CONTRACT_ADDRESS, HOLESKY_USDC_TOKEN_ADDRESS) tidak lengkap di .env!");
        await sendReport("❌ Konfigurasi Holesky (Complex Send) tidak lengkap di .env!");
        return;
    }
    
    // Menggunakan ethers.utils.isAddress untuk ethers v5
    if (!usdcTokenAddr.startsWith("0x") || !ethers.utils.isAddress(usdcTokenAddr)) {
        logger.error(`HOLESKY_USDC_TOKEN_ADDRESS tidak valid: ${usdcTokenAddr}`);
        await sendReport(`❌ Alamat USDC Holesky tidak valid di .env: ${usdcTokenAddr}`);
        return;
    }
    if (!holeskyBridgeAddr.startsWith("0x") || !ethers.utils.isAddress(holeskyBridgeAddr)) {
        logger.error(`HOLESKY_BRIDGE_CONTRACT_ADDRESS tidak valid: ${holeskyBridgeAddr}`);
        await sendReport(`❌ Alamat Bridge Holesky tidak valid di .env: ${holeskyBridgeAddr}`);
        return;
    }

    // =======================================================================
    // Parameter Hardcoded (sesuai JSON dan permintaanmu)
    // =======================================================================
    const usdcAmount = "10000"; // 0.01 USDC (asumsi 6 desimal untuk USDC)
    const param_uint32_1 = "4";
    const param_uint64_2_timeoutHeight = "0";
    const param_tuple_uint8_1 = "0";
    const param_tuple_uint8_2 = "2";
    const instructionPayload = "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf8000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c7370000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001457978bfe465ad9b1c0bf80f6c1539d300705ea500000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003f78696f6e316b76377a7278686364723537363261727732327734716b6871726c307164783574746d6673687978746739346e356b6b6d37677336333276326600";
    const gasLimit = parseInt(process.env.HOLESKY_GAS_LIMIT_COMPLEX_SEND || "800000");
    // =======================================================================

    const result = await sendHoleskyToXionBridge_Complex(
        holeskyRpc,
        holeskyKey,
        holeskyBridgeAddr,
        usdcTokenAddr,
        usdcAmount,
        param_uint32_1,
        param_uint64_2_timeoutHeight,
        param_tuple_uint8_1,
        param_tuple_uint8_2,
        instructionPayload,
        gasLimit
    );

    if (result && result.packetHash) {
        logger.info(`[HoleskyComplex->Xion] Bridge process for 0.01 USDC initiated. Packet Hash: ${result.packetHash}`);
        logger.info("!!! TODO: Implement Xion side completion logic here using the packetHash !!!");
    } else if (result && result.holeskyTxHash) {
        logger.warn(`[HoleskyComplex->Xion] Bridge for 0.01 USDC initiated on Holesky (${result.holeskyTxHash}), but packet hash not retrieved.`);
    } else {
        logger.error(`[HoleskyComplex->Xion] Failed to initiate bridge for 0.01 USDC from Holesky.`);
    }
}

// --------------------------------------------------------------------------
// 7. MAIN EXECUTION LOGIC
// --------------------------------------------------------------------------
async function main() {
    logger.info("===== RUNNING HOLESKY (0.01 USDC - Complex Send) -> XION TRANSFER SCRIPT =====");
    await runHoleskyToXionTransfer(); // Langsung panggil fungsi runner yang relevan
    logger.info("===== SCRIPT EXECUTION FINISHED =====");
}

main().catch(e => {
    logger.error(`Unhandled error in main execution: ${e.message}`);
    logger.error(e.stack);
    sendReport(`🚨 CRITICAL ERROR in script: ${e.message.substring(0,150)}...`).finally(() => process.exit(1));
});
