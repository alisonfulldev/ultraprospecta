/**
 * import-receita.js
 *
 * Importa os dados abertos da Receita Federal para cnpj.db (SQLite).
 *
 * USO:
 *   node import-receita.js
 *
 * Os arquivos da Receita são baixados automaticamente de dados.gov.br.
 * Requer ~10 GB livres (download) + ~4 GB para o SQLite final.
 * Rode uma vez por mês para manter os dados atualizados.
 *
 * Fontes oficiais:
 *   https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj
 */

'use strict';
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const readline = require('readline');
const iconv   = require('iconv-lite');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'cnpj.db');
const TMP_DIR = path.join(__dirname, 'receita_tmp');

// ── URLs dos arquivos da Receita Federal ──────────────────────────────────────
// Verifique a URL atual em dados.gov.br — pode mudar a cada atualização mensal
const BASE_URL = 'https://dadosabertos.rfb.gov.br/CNPJ';
const FILES = {
    municipios:       [`${BASE_URL}/Municipios.zip`],
    cnaes:            [`${BASE_URL}/Cnaes.zip`],
    empresas:         Array.from({length:10}, (_,i) => `${BASE_URL}/Empresas${i}.zip`),
    estabelecimentos: Array.from({length:10}, (_,i) => `${BASE_URL}/Estabelecimentos${i}.zip`),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { process.stdout.write(`[${new Date().toTimeString().slice(0,8)}] ${msg}\n`); }

function download(url, dest) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) { log(`  ↩ já existe: ${path.basename(dest)}`); return resolve(); }
        log(`  ↓ baixando: ${path.basename(dest)}`);
        const file = fs.createWriteStream(dest);
        const proto = url.startsWith('https') ? https : http;
        proto.get(url, res => {
            if (res.statusCode === 302 || res.statusCode === 301)
                return download(res.headers.location, dest).then(resolve).catch(reject);
            if (res.statusCode !== 200) {
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', err => { fs.unlinkSync(dest); reject(err); });
    });
}

function unzip(zipPath) {
    return new Promise((resolve, reject) => {
        const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
        if (AdmZip) {
            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries().filter(e => !e.isDirectory);
            const out = entries.map(e => {
                const dest = path.join(TMP_DIR, e.entryName);
                zip.extractEntryTo(e, TMP_DIR, false, true);
                return dest;
            });
            return resolve(out);
        }
        // Fallback: usa unzipper se disponível
        const unzipper = (() => { try { return require('unzipper'); } catch { return null; } })();
        if (!unzipper) return reject(new Error('Instale adm-zip ou unzipper: npm install adm-zip'));
        const results = [];
        fs.createReadStream(zipPath)
            .pipe(unzipper.Parse())
            .on('entry', entry => {
                const out = path.join(TMP_DIR, path.basename(entry.path));
                results.push(out);
                entry.pipe(fs.createWriteStream(out));
            })
            .on('finish', () => resolve(results))
            .on('error', reject);
    });
}

async function readCsvLines(filePath, onLine, sep = ';') {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath)
            .pipe(iconv.decodeStream('latin1'));
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let count = 0;
        rl.on('line', line => { onLine(line.split(sep), count++); });
        rl.on('close', resolve);
        rl.on('error', reject);
    });
}

// ── Setup DB ──────────────────────────────────────────────────────────────────
function setupDb() {
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = OFF');
    db.pragma('cache_size = -64000'); // 64 MB cache
    db.exec(`
        CREATE TABLE IF NOT EXISTS estabelecimentos (
            cnpj          TEXT PRIMARY KEY,
            razao_social  TEXT,
            nome_fantasia TEXT,
            cnae_principal TEXT,
            cnae_desc     TEXT,
            uf            TEXT,
            municipio     TEXT,
            ddd1          TEXT,
            telefone1     TEXT,
            ddd2          TEXT,
            telefone2     TEXT,
            email         TEXT,
            logradouro    TEXT,
            numero        TEXT,
            bairro        TEXT,
            cep           TEXT,
            porte         TEXT,
            situacao      TEXT DEFAULT '02'
        );
        CREATE INDEX IF NOT EXISTS idx_cnae ON estabelecimentos(cnae_principal);
        CREATE INDEX IF NOT EXISTS idx_uf   ON estabelecimentos(uf);
        CREATE INDEX IF NOT EXISTS idx_mun  ON estabelecimentos(municipio);
        CREATE INDEX IF NOT EXISTS idx_sit  ON estabelecimentos(situacao);
    `);
    return db;
}

// ── Importação ────────────────────────────────────────────────────────────────
async function run() {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

    log('=== UltraProspec — Importação Receita Federal ===');
    log(`Destino SQLite: ${DB_PATH}`);
    log(`Pasta temporária: ${TMP_DIR}`);
    log('');

    const db = setupDb();

    // 1. Municípios — code → nome
    log('1/4 Carregando municípios...');
    const municipios = new Map();
    try {
        await download(FILES.municipios[0], path.join(TMP_DIR, 'Municipios.zip'));
        const files = await unzip(path.join(TMP_DIR, 'Municipios.zip'));
        await readCsvLines(files[0], cols => {
            if (cols.length >= 2) municipios.set(cols[0].trim(), cols[1].trim());
        });
        log(`  ${municipios.size} municípios carregados`);
    } catch (e) { log(`  ⚠ municípios: ${e.message} — continuando sem nomes de cidades`); }

    // 2. CNAEs — code → descrição
    log('2/4 Carregando CNAEs...');
    const cnaes = new Map();
    try {
        await download(FILES.cnaes[0], path.join(TMP_DIR, 'Cnaes.zip'));
        const files = await unzip(path.join(TMP_DIR, 'Cnaes.zip'));
        await readCsvLines(files[0], cols => {
            if (cols.length >= 2) cnaes.set(cols[0].trim(), cols[1].trim());
        });
        log(`  ${cnaes.size} CNAEs carregados`);
    } catch (e) { log(`  ⚠ CNAEs: ${e.message}`); }

    // 3. Empresas — cnpj_basico → razao_social, porte
    log('3/4 Carregando empresas...');
    const empresas = new Map();
    for (const url of FILES.empresas) {
        const zipFile = path.join(TMP_DIR, path.basename(url));
        try {
            await download(url, zipFile);
            const files = await unzip(zipFile);
            await readCsvLines(files[0], (cols, i) => {
                // 0:cnpj_basico 1:razao_social 5:porte
                if (cols.length >= 2)
                    empresas.set(cols[0].trim(), { razao: cols[1].trim(), porte: (cols[5]||'').trim() });
                if (i % 500000 === 0) process.stdout.write(`\r  ${empresas.size} empresas...`);
            });
        } catch (e) { log(`\n  ⚠ ${path.basename(url)}: ${e.message}`); }
    }
    log(`\n  ${empresas.size} empresas carregadas`);

    // 4. Estabelecimentos — principal
    log('4/4 Importando estabelecimentos para SQLite...');
    db.exec('DELETE FROM estabelecimentos');

    const insert = db.prepare(`
        INSERT OR REPLACE INTO estabelecimentos
        (cnpj, razao_social, nome_fantasia, cnae_principal, cnae_desc,
         uf, municipio, ddd1, telefone1, ddd2, telefone2, email,
         logradouro, numero, bairro, cep, porte, situacao)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const insertMany = db.transaction(rows => {
        for (const r of rows) insert.run(r);
    });

    let total = 0, skipped = 0;
    for (const url of FILES.estabelecimentos) {
        const zipFile = path.join(TMP_DIR, path.basename(url));
        try {
            await download(url, zipFile);
            const files = await unzip(zipFile);

            let batch = [];
            await readCsvLines(files[0], cols => {
                // Ignora inativos/baixados/suspensos para economizar espaço
                const situacao = (cols[5] || '').trim();
                if (situacao !== '02') { skipped++; return; }

                const cnpj_basico = cols[0].trim();
                const emp   = empresas.get(cnpj_basico) || {};
                const cnae  = (cols[11] || '').trim();
                const munCod = (cols[20] || '').trim();

                batch.push([
                    `${cnpj_basico}${(cols[1]||'').trim()}${(cols[2]||'').trim()}`, // cnpj completo
                    emp.razao  || '',
                    (cols[4]  || '').trim(),  // nome_fantasia
                    cnae,
                    cnaes.get(cnae) || '',
                    (cols[19] || '').trim(),  // uf
                    municipios.get(munCod) || munCod,
                    (cols[21] || '').trim(),  // ddd1
                    (cols[22] || '').trim(),  // telefone1
                    (cols[23] || '').trim(),  // ddd2
                    (cols[24] || '').trim(),  // telefone2
                    (cols[27] || '').trim().toLowerCase(), // email
                    (cols[13] || '').trim(),  // logradouro
                    (cols[15] || '').trim(),  // numero
                    (cols[17] || '').trim(),  // bairro
                    (cols[18] || '').trim(),  // cep
                    emp.porte || '',
                    situacao
                ]);

                if (batch.length >= 5000) { insertMany(batch); total += batch.length; batch = []; }
                if (total % 100000 === 0) process.stdout.write(`\r  ${total.toLocaleString()} inseridos...`);
            });
            if (batch.length) { insertMany(batch); total += batch.length; }
        } catch (e) { log(`\n  ⚠ ${path.basename(url)}: ${e.message}`); }
    }

    log(`\n  ✅ ${total.toLocaleString()} estabelecimentos ativos importados`);
    log(`  ⏭  ${skipped.toLocaleString()} inativos ignorados`);
    log('');
    log('Criando índices...');
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cnae ON estabelecimentos(cnae_principal);
        CREATE INDEX IF NOT EXISTS idx_uf   ON estabelecimentos(uf);
        CREATE INDEX IF NOT EXISTS idx_mun  ON estabelecimentos(municipio);
        CREATE INDEX IF NOT EXISTS idx_sit  ON estabelecimentos(situacao);
    `);
    db.close();
    log('✅ Importação concluída! cnpj.db pronto para uso.');
    log(`   Tamanho: ${(fs.statSync(DB_PATH).size / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

run().catch(err => { console.error('❌ Erro fatal:', err.message); process.exit(1); });
