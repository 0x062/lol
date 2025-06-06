const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate"); // Hapus 'coin' dari sini
const { calculateFee, GasPrice, coin } = require("@cosmjs/stargate");   // Tambahkan 'coin' di sini
const crypto = require('crypto');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = {
  info: (msg) => console.log(`[✓] ${msg}`),
  warn: (msg) => console.log(`[⚠] ${msg}`),
  error: (msg) => console.log(`[✗] ${msg}`),
  success: (msg) => console.log(`[✅] ${msg}`),
  loading: (msg) => console.log(`[⟳] ${msg}`),
};
let reportBuffer = [];
function bufferReport(text) { reportBuffer.push(text); }
// ... (import lain)
// Pastikan ini ada jika belum:
// const { sendReport } = require('./telegramReporter'); // <== Ini mengimpor fungsi asli Anda

async function flushReport() {
    if (!reportBuffer.length) return; // Jangan lakukan apa-apa jika buffer kosong

    const messageToSend = reportBuffer.join("\n");

    // --- BAGIAN PENGIRIMAN TELEGRAM ---
    try {
        logger.loading("Sending report to Telegram..."); // Tambahkan log
        // Ganti console.log di bawah dengan pemanggil sendReport asli Anda:
        // console.log("--- TELEGRAM REPORT (SIMULASI) ---");
        // console.log(messageToSend);
        // console.log("----------------------------------");
        
        // ++ AKTIFKAN BARIS INI UNTUK MENGIRIM KE TELEGRAM ++
        await sendReport(messageToSend); 
        logger.success("Telegram report sent successfully!"); // Tambahkan log sukses

    } catch (err) {
        logger.error(`Telegram report failed: ${err.message}`);
    }
    // ---------------------------------

    reportBuffer = []; // Kosongkan buffer
}
function timelog() { return new Date().toISOString(); }
// --------------------------------------------------------------------------

async function pollUnionForPacketHash(txHash, retries = 50, intervalMs = 6000) {
    const POLLING_URL = "https://graphql.union.build/v1/graphql";
    const HEADERS = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': 'https://app.union.build', // Penting untuk CORS
        'Referer': 'https://app.union.build/',
    };

    // Format hash Xion agar mirip contoh (tambah 0x)
    // Hash Xion biasanya Uppercase, jadi kita ubah ke lowercase dulu
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
                return result[0].packet_hash; // KEMBALIKAN PACKET HASH
            } else {
                logger.loading(`  Waiting for Union packet... (Try ${i + 1}/${retries})`);
            }
        } catch (e) {
            // Kita log error tapi tetap lanjut polling (mungkin error sementara)
            logger.error(`  Polling error: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
        }
        await delay(intervalMs); // Tunggu sebelum mencoba lagi
    }

    logger.warn(`  Could not retrieve Packet hash after ${retries} retries.`);
    return null; // Kembalikan null jika tidak ditemukan
}

async function sendToXionBridge(mnemonic, xionRpcEndpoint, bridgeContractAddress, messageTemplate, fundsToSend = []) {
    const XION_PREFIX = "xion";
    const BRIDGE_CONTRACT_ADDRESS = "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; 
    const GAS_PRICE_STR = "0.025uxion"; 
    const GAS_LIMIT = 700000; 

    // ... (kode setup wallet & koneksi - tetap sama) ...
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

    // +++ PERUBAHAN DI SINI UNTUK TIMEOUT 24 JAM +++
    const twentyFourHoursInNs = 24n * 60n * 60n * 1000n * 1_000_000n; // 24 jam dalam nanodetik
    const currentTimestampNs = BigInt(Date.now()) * 1_000_000n;      // Waktu saat ini dalam nanodetik
    payload.send.timeout_timestamp = (currentTimestampNs + twentyFourHoursInNs).toString();
    // +++ SELESAI PERUBAHAN TIMEOUT +++

    payload.send.salt = '0x' + crypto.randomBytes(32).toString('hex');

    logger.loading(`Sending message to ${BRIDGE_CONTRACT_ADDRESS}...`);
    // console.log(JSON.stringify(payload, null, 2)); // Baris ini sudah kita hapus/komentari

    const funds = [ coin("10000", "uxion") ];
    const fee = calculateFee(GAS_LIMIT, GasPrice.fromString(GAS_PRICE_STR));

    try {
        const result = await client.execute(
            senderXionAddress,
            BRIDGE_CONTRACT_ADDRESS,
            payload, 
            fee, 
            "Xion to Holesky via JS Partner (24h timeout)", // Update memo jika mau 
            funds
        );

        const xionTxHash = result.transactionHash;
        logger.success(`Transaction sent on Xion! Hash: ${xionTxHash}`);
        
        const packetHash = await pollUnionForPacketHash(xionTxHash);

        if (packetHash) {
             bufferReport(`✅ Initiated Xion -> Holesky | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | Packet: \`${packetHash.substring(0, 10)}...\``);
        } else {
             bufferReport(`✅ Initiated Xion -> Holesky | Xion Tx: \`${xionTxHash.substring(0, 6)}...\` | ⚠ Packet N/A`);
        }

    } catch (err) {
        logger.error(`Xion transaction failed: ${err.message}`);
        bufferReport(`❌ Failed Xion -> Holesky: ${err.message}`);
    }

    await flushReport();
}
// --- Fungsi untuk Menjalankan ---
async function runXionTransfer() {
    require('dotenv').config(); // Pastikan .env dimuat
    
    const xionMnemonic = process.env.XION_MNEMONIC; 
    const xionRpc = "https://rpc.xion-testnet-2.burnt.com"; // <== PERIKSA KEMBALI RPC INI!
    
    // +++ ALAMAT KONTRAK DARI JSON KEDUA ANDA +++
    const bridgeAddr = "xion1336jj8ertl8h7rdvnz4dh5rqahd09cy0x43guhsxx6xyrztx292qlzhdk9"; 
    
    // +++ TEMPLATE JSON DARI JSON PERTAMA ANDA (SUDAH DIISI) +++
    const xionMessageTemplate = {
      "send": {
        "channel_id": 1,
        "timeout_height": "0",
        "timeout_timestamp": "1748601863261000000", // Akan di-update otomatis
        "salt": "0x729eba29958daf8b86024357677479b6ced616e973f0a7c6b287511b581a602a", // Akan di-update otomatis
        "instruction": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a000000000000000000000000000000000000000000000000000000000000001e000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000002b78696f6e316d3377636b68387576757374393663366b706a38307a726e6b776a33386d396376666a6c737000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000144375d555ede2a6f1892104a5a953fa9c2ea18bf800000000000000000000000000000000000000000000000000000000000000000000000000000000000000057578696f6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000458494f4e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000478696f6e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001407D878ab885453DcB2baa987E6761C86b5f45F27000000000000000000000000"
      }
    };

    if (!xionMnemonic) {
        logger.error("XION_MNEMONIC tidak ditemukan di .env!");
        return;
    }
    if (!xionRpc) {
        logger.error("XION_RPC tidak valid!");
        return;
    }

    await sendToXionBridge(xionMnemonic, xionRpc, bridgeAddr, xionMessageTemplate);
}

// Panggil fungsi utama untuk memulai
runXionTransfer().catch(console.error);
