const path = require('path');

let db = null;

const DB_PATH = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'cnpj.db')
    : path.join(__dirname, 'cnpj.db');

function getDb() {
    if (db) return db;
    try {
        const Database = require('better-sqlite3');
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS estabelecimentos (
                cnpj        TEXT PRIMARY KEY,
                razao_social TEXT,
                nome_fantasia TEXT,
                cnae_principal TEXT,
                cnae_desc   TEXT,
                uf          TEXT,
                municipio   TEXT,
                ddd1        TEXT,
                telefone1   TEXT,
                ddd2        TEXT,
                telefone2   TEXT,
                email       TEXT,
                logradouro  TEXT,
                numero      TEXT,
                bairro      TEXT,
                cep         TEXT,
                porte       TEXT,
                situacao    TEXT DEFAULT '02'
            );
            CREATE INDEX IF NOT EXISTS idx_cnae ON estabelecimentos(cnae_principal);
            CREATE INDEX IF NOT EXISTS idx_uf   ON estabelecimentos(uf);
            CREATE INDEX IF NOT EXISTS idx_mun  ON estabelecimentos(municipio);
            CREATE INDEX IF NOT EXISTS idx_sit  ON estabelecimentos(situacao);
        `);
        console.log('✅ SQLite (cnpj.db) conectado');
    } catch (e) {
        console.warn('⚠️  SQLite não disponível:', e.message);
        db = null;
    }
    return db;
}

module.exports = { getDb };
