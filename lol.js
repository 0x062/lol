// --- IMPORTS ---
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { calculateFee, GasPrice, coin } = require("@cosmjs/stargate");
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config(); // Memuat .env
// Untuk laporan Telegram, pastikan file ini ada dan dikonfigurasi
// const { sendReport } = require('./telegramReporter'); 

// --- FUNGSI UTILITAS DASAR ---
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logger = {
  info: (msg) => console.log(`[✓] ${msg}`),
  warn: (msg) => console.log(`[⚠] ${msg}`),
  error: (msg) => console.log(`[✗] ${msg}`),
  success: (msg) => console.log(`[✅] ${msg}`),
  loading: (msg) => console.log(`[⟳] ${msg}`),
};

let reportBuffer = [];
function bufferReport(text) {
  reportBuffer.push(text);
}

async function flushReport() {
  if (!reportBuffer.length) return;
  const messageToSend = reportBuffer.join("\n");
  logger.loading("Sending report to Telegram...");
  try {
    // --- AKTIFKAN INI UNTUK PENGIRIMAN TELEGRAM ASLI ---
    // await sendReport(messageToSend); 
    // --- ATAU GUNAKAN CONSOLE.LOG UNTUK TESTING ---
    console.log("\n--- TELEGRAM REPORT (SIMULASI) ---");
    console.log(messageToSend);
    console.log("----------------------------------\n");
    logger.success("Telegram report (simulasi) displayed!");
  } catch (err) {
    logger.error(`Telegram report failed: ${err.message}`);
  }
  reportBuffer = [];
}

function timelog() { 
  // Anda bisa menggunakan moment-timezone jika sudah diinstal dan di-require
  // return moment().tz('Asia/Jakarta').format('HH:mm:ss | DD-MM-YYYY'); 
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

// --- FUNGSI POLLING ---
async function pollUnionForPacketHash(txHash, retries = 50, intervalMs = 6000) {
    const POLLING_URL = "https://graphql.union.build/v1/graphql";
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
        variables: {
            submission_tx_hash: submissionHash
        },
        operationName: "GetPacketHashBySubmissionTxHash"
    };

    logger.loading(`Polling Union for Packet Hash using ${submissionHash.substring(0, 15)}...`);
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.post(POLLING_URL, data, { headers: HEADERS });
            const result = res.data?.data?.v2_transfers;
            if (result && result.length > 0 && result[0].packet_hash) {
                logger.success(`  ⮡ Packet Hash found: ${result[0].packet_hash}`);
                return result[0].packet_hash;
            } else {
                logger.loading(`  Waiting for Union packet... (Try ${i + 1}/${retries})`);
            }
        } catch (e) {
            logger.error(`  Polling error: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
        }
        await delay(intervalMs);
    }
    logger.warn(`  Could not retrieve Packet hash after ${retries} retries.`);
    return null;
}

// --- FUNGSI UTAMA PENGIRIMAN XION ---
async function sendToXionBridge(mnemonic, xionRpcEndpoint, bridgeContractAddress, messageTemplate, fundsForContract) {
    const XION_PREFIX = "xion";
    const GAS_PRICE_STR = "0.025uxion"; 
    const GAS_LIMIT = 750000; 

    if (!bridgeContractAddress || !bridgeContractAddress.startsWith("xion1")) {
        logger.error("Alamat Kontrak Jembatan Xion tidak valid!");
        bufferReport(`❌ Gagal: Alamat Kontrak Jembatan Xion tidak valid! Isi: ${bridgeContractAddress}`);
        await flushReport();
        return;
    }

    logger.loading(`Preparing Xion wallet...`);
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: XION_PREFIX });
    const [firstAccount] = await wallet.getAccounts();
    const senderXionAddress = firstAccount.address;

    logger.loading(`Connecting to Xion Testnet (${xionRpcEndpoint})...`);
    const client = await SigningCosmWasmClient.connectWithSigner(
        xionRpcEndpoint,
        wallet
    );
    logger.info(`Xion Wallet Address: ${senderXionAddress}`);

    let payload = JSON.parse(JSON.stringify(messageTemplate)); 

    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n;
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    logger.loading(`Preparing to send message to ${bridgeContractAddress} with funds: ${JSON.stringify(fundsForContract)}`);
    // logger.info("Full payload to be sent to contract:", JSON.stringify(payload, null, 2)); // Uncomment untuk debug payload

    const fee = calculateFee(GAS_LIMIT, GasPrice.fromString(GAS_PRICE_STR));

    try {
        const result = await client.execute(
            senderXionAddress,
            bridgeContractAddress,
            payload, // Kirim seluruh objek { "send": { ... } }
            fee, 
            "Xion USDC to Holesky via JS Patner (24h)", 
            fundsForContract
        );

        const xionTxHash = result.transactionHash;
        logger.success(`USDC Transfer initiated on Xion! Hash: ${xionTxHash}`);
        
        const packetHash = await pollUnionForPacketHash(xionTxHash);

        if (packetHash) {
             bufferReport(`✅ USDC Xion -> Holesky @ ${timelog()} | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
             bufferReport(`✅ USDC Xion -> Holesky @ ${timelog()} | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | ⚠ Packet N/A`);
        }

    } catch (err) {
        logger.error(`Xion USDC transfer failed: ${err.message}`);
        bufferReport(`❌ Failed USDC Xion -> Holesky @ ${timelog()}: ${err.message}`);
    }

    await flushReport();
}

// --- FUNGSI UNTUK MENJALANKAN TRANSFER USDC ---
async function runUSDCTransfer() {
    logger.info("Starting XION -> Holesky USDC Transfer Script...");
    
    const xionMnemonic = process.env.XION_MNEMONIC; 
    const xionRpc = "https://rpc.xion-testnet-2.burnt.com"; 
    const bridgeAddr = "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; 
    
    const usdcMessageTemplate = {
      "send": {
        "channel_id": "1",
        "timeout_height": "0",
        "timeout_timestamp": "1748611874173000000", // Akan di-update otomatis
        "salt": "0x0fcb7b7ffb279f3fdb3f796c38c8757216154cec1f3d121d6542496d6ee0bdf0", // Akan di-update otomatis
        "instruction": "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000048000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000002e000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000036000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf800000000000000000000000000000000000000000000000000000000000000000000000000000000000000446962632f3634393041374541423631303539424643314344444542303539313744443730424446334136313136353431363241314134374442393330443430443841463400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000446962632f3634393041374541423631303539424643314344444542303539313744443730424446334136313136353431363241314134374442393330443430443841463400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000446962632f36343930413745414236313035394246433143444445423035393137444437304244463341363131363534313632413141343744423933304434304438414634000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014c0238f9f46DDCEd7C1e4e54c454a63774098Eb36000000000000000000000000"
      }
    };

    const usdcDenom = "ibc/6490A7EAB61059BFC1CDDEB05917DD70BDF3A611654162A1A47DB930D40D8AF4";
    // Ini 0.001 USDC jika 6 desimal. Sesuaikan jika Anda ingin mengirim jumlah berbeda!
    // Contoh: 1 USDC (6 desimal) = "1000000"
    const usdcAmount = "1000"; 
    const fundsForBridge = [coin(usdcAmount, usdcDenom)];

    if (!xionMnemonic) { logger.error("XION_MNEMONIC tidak ditemukan di .env!"); return; }
    if (!xionRpc) { logger.error("XION_RPC tidak valid!"); return; }
    if (!usdcMessageTemplate.send || !usdcMessageTemplate.send.instruction) {
         logger.error("Template JSON 'send' tidak lengkap!");
         return;
    }

    await sendToXionBridge(xionMnemonic, xionRpc, bridgeAddr, usdcMessageTemplate, fundsForBridge);

    // Opsi: Tambahkan delay di akhir jika perlu
    // const finalDelayMs = 3000; // 3 detik
    // logger.info(`Script finished. Waiting ${finalDelayMs / 1000} seconds...`);
    // await delay(finalDelayMs);
    logger.info("Script execution complete.");
}

// --- PANGGIL FUNGSI UTAMA ---
runUSDCTransfer().catch(error => {
    logger.error(`Unhandled error in script: ${error.message}`);
    console.error(error); // Cetak stack trace untuk debug lebih lanjut
});
