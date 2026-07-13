require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3001;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const ALLOW_SERVICE_TOKEN = process.env.ALLOW_SERVICE_TOKEN === 'true';
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER || '';
const STRIPE_PRICE_PROFESSIONAL = process.env.STRIPE_PRICE_PROFESSIONAL || '';
const STRIPE_PRICE_ENTERPRISE = process.env.STRIPE_PRICE_ENTERPRISE || '';
const AI_DAILY_DOCUMENT_LIMIT = Number(process.env.AI_DAILY_DOCUMENT_LIMIT || 100);
const AI_MONTHLY_DOCUMENT_HARD_LIMIT = Number(process.env.AI_MONTHLY_DOCUMENT_HARD_LIMIT || 1000);
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '1551241102@qq.com';
const AI_REVIEW_NOTICE = 'AI-GENERATED DRAFT — HUMAN REVIEW REQUIRED: Verify every name, date, price, legal statement, and jurisdiction-specific requirement before use. This document is not legal, medical, tax, or regulatory advice.';

// ── Helper: wait for a given ms ──────────────────────────
const wait = ms => new Promise(r => setTimeout(r, ms));
const escHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// ═══════════════════════════════════════════════════════════
// PART 1 — Database
// ═══════════════════════════════════════════════════════════

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'funeral_home.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','director','staff','viewer')),
      password_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'first_call' CHECK(status IN (
        'first_call','removal','arrangement_pending','arrangement_done',
        'documents_generating','documents_ready',
        'service_planned','service_in_progress','service_completed',
        'post_service','closed'
      )),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      assigned_to TEXT REFERENCES users(id),
      created_by TEXT REFERENCES users(id),
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS deceased_info (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      age TEXT DEFAULT '',
      date_of_birth TEXT DEFAULT '',
      date_of_death TEXT DEFAULT '',
      place_of_death TEXT DEFAULT '',
      residence TEXT DEFAULT '',
      cause_of_death TEXT DEFAULT '',
      sex TEXT DEFAULT '',
      marital_status TEXT DEFAULT '',
      occupation TEXT DEFAULT '',
      education TEXT DEFAULT '',
      spouse TEXT DEFAULT '',
      children TEXT DEFAULT '',
      grandchildren TEXT DEFAULT '',
      predeceased_by TEXT DEFAULT '',
      father_name TEXT DEFAULT '',
      mother_name TEXT DEFAULT '',
      religion TEXT DEFAULT '',
      disposition TEXT DEFAULT '',
      funeral_home TEXT DEFAULT '',
      service_date TEXT DEFAULT '',
      service_location TEXT DEFAULT '',
      visitation TEXT DEFAULT '',
      burial TEXT DEFAULT '',
      military_service TEXT DEFAULT '',
      organizations TEXT DEFAULT '',
      hobbies TEXT DEFAULT '',
      charities TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      tone TEXT DEFAULT 'traditional'
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL CHECK(doc_type IN (
        'obituary','death_certificate','notifications','checklist',
        'cremation_authorization','ssa721','va_benefits','gpl_statement'
      )),
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generating','done','error')),
      error_msg TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pricing_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('professional','facility','transportation','casket','container','cremation','cemetery','merchandise','other')),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      taxable INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pricing_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'at-need' CHECK(type IN ('at-need','pre-need')),
      total_price REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS package_items (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES pricing_packages(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES pricing_items(id),
      quantity INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS case_selections (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      package_id TEXT REFERENCES pricing_packages(id),
      item_id TEXT REFERENCES pricing_items(id),
      quantity INTEGER DEFAULT 1,
      price REAL NOT NULL DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cremation_authorizations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      authorizer_name TEXT NOT NULL DEFAULT '',
      authorizer_relationship TEXT NOT NULL DEFAULT '',
      authorizer_address TEXT DEFAULT '',
      authorizer_phone TEXT DEFAULT '',
      disposition_method TEXT DEFAULT 'cremation' CHECK(disposition_method IN ('cremation','entombment','burial')),
      crematory_name TEXT DEFAULT '',
      special_instructions TEXT DEFAULT '',
      id_verified INTEGER DEFAULT 0,
      id_type TEXT DEFAULT '',
      id_number TEXT DEFAULT '',
      signed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pre_need_contracts (
      id TEXT PRIMARY KEY,
      case_id TEXT REFERENCES cases(id),
      client_name TEXT NOT NULL DEFAULT '',
      client_email TEXT DEFAULT '',
      client_phone TEXT DEFAULT '',
      contract_date TEXT DEFAULT (datetime('now')),
      package_id TEXT REFERENCES pricing_packages(id),
      total_amount REAL NOT NULL DEFAULT 0,
      amount_paid REAL NOT NULL DEFAULT 0,
      payment_plan TEXT DEFAULT 'lump_sum' CHECK(payment_plan IN ('lump_sum','installment','trust')),
      trust_fund_ref TEXT DEFAULT '',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','fulfilled','cancelled','transferred')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memorials (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      slug TEXT UNIQUE NOT NULL,
      public_title TEXT DEFAULT '',
      public_photo TEXT DEFAULT '',
      life_story TEXT DEFAULT '',
      is_published INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memorial_messages (
      id TEXT PRIMARY KEY,
      memorial_id TEXT NOT NULL REFERENCES memorials(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      is_approved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL CHECK(item_type IN ('casket','urn','container','flower','other')),
      name TEXT NOT NULL,
      sku TEXT DEFAULT '',
      description TEXT DEFAULT '',
      quantity INTEGER DEFAULT 0,
      reorder_level INTEGER DEFAULT 5,
      supplier TEXT DEFAULT '',
      cost_price REAL DEFAULT 0,
      retail_price REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS case_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS funeral_directors (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      license_number TEXT DEFAULT '',
      license_state TEXT DEFAULT '',
      nfda_member INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS billing_accounts (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL DEFAULT 'Default Customer',
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recharge_orders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES billing_accounts(id),
      amount REAL NOT NULL DEFAULT 0,
      plan_id TEXT DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending','completed','failed','cancelled')),
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','closed')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

initDB();

const DEFAULT_ORG_ID = 'default-org';
const DEFAULT_PLAN_ID = 'professional';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableColumns(table).includes(column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message || '')) throw err;
    }
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate);
}

function normalizeSlug(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function migrateProductionSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Default Funeral Home',
      slug TEXT UNIQUE NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('trial','active','past_due','suspended','cancelled')),
      plan_id TEXT NOT NULL DEFAULT 'professional',
      ai_credit_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monthly_price REAL NOT NULL DEFAULT 0,
      included_cases INTEGER NOT NULL DEFAULT 0,
      included_ai_documents INTEGER NOT NULL DEFAULT 0,
      overage_case_price REAL NOT NULL DEFAULT 0,
      overage_document_price REAL NOT NULL DEFAULT 0,
      features TEXT DEFAULT '',
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id),
      event_type TEXT NOT NULL CHECK(event_type IN ('case_created','ai_document_generated','manual_document_saved','memorial_published')),
      quantity INTEGER NOT NULL DEFAULT 1,
      entity_type TEXT DEFAULT '',
      entity_id TEXT DEFAULT '',
      metadata TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      backup_type TEXT NOT NULL DEFAULT 'manual',
      path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const table of ['users','cases','pricing_items','pricing_packages','billing_accounts','support_tickets','inventory','pre_need_contracts','audit_log']) {
    addColumnIfMissing(table, 'organization_id', `TEXT DEFAULT '${DEFAULT_ORG_ID}'`);
  }
  addColumnIfMissing('support_tickets', 'priority', `TEXT DEFAULT 'Normal'`);
  addColumnIfMissing('support_tickets', 'topic', `TEXT DEFAULT 'Other'`);
  addColumnIfMissing('billing_accounts', 'monthly_case_limit', 'INTEGER DEFAULT 100');
  addColumnIfMissing('billing_accounts', 'monthly_document_limit', 'INTEGER DEFAULT 500');
  addColumnIfMissing('organizations', 'stripe_customer_id', `TEXT DEFAULT ''`);
  addColumnIfMissing('organizations', 'stripe_subscription_id', `TEXT DEFAULT ''`);
  addColumnIfMissing('organizations', 'subscription_current_period_end', `TEXT DEFAULT ''`);
  addColumnIfMissing('organizations', 'payment_provider', `TEXT DEFAULT 'stripe'`);
  addColumnIfMissing('organizations', 'payment_mode', `TEXT DEFAULT 'test'`);
  addColumnIfMissing('organizations', 'payment_public_key', `TEXT DEFAULT ''`);
  addColumnIfMissing('organizations', 'payment_instructions', `TEXT DEFAULT ''`);
  addColumnIfMissing('organizations', 'payments_enabled', `INTEGER DEFAULT 0`);
  addColumnIfMissing('subscription_plans', 'stripe_price_id', `TEXT DEFAULT ''`);
  addColumnIfMissing('subscription_plans', 'manual_payment_url', `TEXT DEFAULT ''`);
  addColumnIfMissing('recharge_orders', 'plan_id', `TEXT DEFAULT ''`);

  db.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, status, plan_id) VALUES (?, ?, ?, ?, ?)`)
    .run(DEFAULT_ORG_ID, 'Default Funeral Home', 'default', 'trial', DEFAULT_PLAN_ID);

  const plans = [
    ['starter', 'Starter', 199, 25, 150, 12, 0.25, 'Cases, AI documents, basic pricing, email support'],
    ['professional', 'Professional', 499, 100, 700, 9, 0.15, 'All core workflows, GPL, cremation auth, memorials, inventory, team accounts'],
    ['enterprise', 'Enterprise', 999, 500, 5000, 5, 0.08, 'Multi-location controls, audit support, priority support, custom templates']
  ];
  const planStmt = db.prepare(`INSERT OR IGNORE INTO subscription_plans
    (id, name, monthly_price, included_cases, included_ai_documents, overage_case_price, overage_document_price, features)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const plan of plans) planStmt.run(...plan);
  db.prepare('UPDATE subscription_plans SET stripe_price_id = ? WHERE id = ?').run(STRIPE_PRICE_STARTER, 'starter');
  db.prepare('UPDATE subscription_plans SET stripe_price_id = ? WHERE id = ?').run(STRIPE_PRICE_PROFESSIONAL, 'professional');
  db.prepare('UPDATE subscription_plans SET stripe_price_id = ? WHERE id = ?').run(STRIPE_PRICE_ENTERPRISE, 'enterprise');

  db.prepare(`UPDATE users SET organization_id = COALESCE(organization_id, ?)`).run(DEFAULT_ORG_ID);
  for (const table of ['cases','pricing_items','pricing_packages','billing_accounts','support_tickets','inventory','pre_need_contracts','audit_log']) {
    db.prepare(`UPDATE ${table} SET organization_id = ? WHERE organization_id IS NULL OR organization_id = ''`).run(DEFAULT_ORG_ID);
  }
}

migrateProductionSchema();

// ── JSON → SQLite migration ──────────────────────────────
function migrateFromJSON() {
  const CASES_FILE = path.join(DATA_DIR, 'cases.json');
  if (!fs.existsSync(CASES_FILE)) return;
  
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM cases').get();
  if (existing.cnt > 0) return; // already migrated

  try {
    const oldCases = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    if (!Array.isArray(oldCases) || oldCases.length === 0) return;

    const insertCase = db.prepare(`INSERT OR IGNORE INTO cases (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`);
    const insertDeceased = db.prepare(`INSERT OR IGNORE INTO deceased_info (id, case_id, full_name, age, date_of_birth, date_of_death, place_of_death, residence, cause_of_death, sex, marital_status, occupation, education, spouse, children, grandchildren, predeceased_by, father_name, mother_name, religion, disposition, funeral_home, service_date, service_location, visitation, burial, military_service, organizations, hobbies, charities, notes, tone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertDoc = db.prepare(`INSERT OR IGNORE INTO documents (id, case_id, doc_type, content, status) VALUES (?, ?, ?, ?, ?)`);
    const insertTimeline = db.prepare(`INSERT OR IGNORE INTO case_timeline (case_id, status, note, created_at) VALUES (?, ?, ?, ?)`);

    const tx = db.transaction(() => {
      for (const c of oldCases) {
        const status = c.status === 'generated' ? 'documents_ready' : (c.status || 'first_call');
        insertCase.run(c.id, status, c.createdAt || new Date().toISOString(), c.updatedAt || c.createdAt || new Date().toISOString());
        const d = c.deceased || {};
        const diId = uuidv4();
        insertDeceased.run(diId, c.id, d.fullName || '', d.age || '', d.dateOfBirth || '', d.dateOfDeath || '',
          d.placeOfDeath || '', d.residence || '', d.causeOfDeath || '', d.sex || '', d.maritalStatus || '',
          d.occupation || '', d.education || '', d.spouse || '', d.children || '', d.grandchildren || '',
          d.predeceasedBy || '', d.fatherName || '', d.motherName || '', d.religion || '', d.disposition || '',
          d.funeralHome || '', d.serviceDate || '', d.serviceLocation || '', d.visitation || '', d.burial || '',
          d.militaryService || '', d.organizations || '', d.hobbies || '', d.charities || '', d.notes || '', d.tone || 'traditional');

        // migrate documents
        const docs = c.documents || {};
        const docMap = { obituary: 'obituary', deathCertificate: 'death_certificate', notifications: 'notifications', checklist: 'checklist' };
        for (const [key, val] of Object.entries(docMap)) {
          if (docs[key] && docs[key].content) {
            insertDoc.run(uuidv4(), c.id, val, docs[key].content, 'done');
          }
        }
        insertTimeline.run(c.id, status, 'Migrated from legacy JSON', c.createdAt || new Date().toISOString());
      }
    });
    tx();
    console.log(`✅ Migrated ${oldCases.length} cases from legacy JSON → SQLite`);
  } catch (e) {
    console.error('Migration error (non-fatal):', e.message);
  }
}

migrateFromJSON();

// ── Seed default pricing items ────────────────────────────
const DEFAULT_PRICING_ITEMS = [
  { cat: 'professional', name: 'Basic Services of Funeral Director & Staff', desc: 'Overhead, planning, coordination', price: 2500 },
  { cat: 'professional', name: 'Embalming', desc: 'Standard embalming procedure', price: 895 },
  { cat: 'professional', name: 'Other Preparation (Hygiene/Cosmetology)', desc: 'Hair styling, makeup, dressing', price: 375 },
  { cat: 'professional', name: 'Refrigeration', desc: 'Per day', price: 150 },
  { cat: 'professional', name: 'Death Certificate Filing', desc: 'Certified copies not included', price: 150 },
  { cat: 'facility', name: 'Visitation / Viewing (1 day)', desc: 'Use of facilities for 4 hours', price: 750 },
  { cat: 'facility', name: 'Funeral Ceremony (chapel)', desc: 'Use of chapel + staff', price: 950 },
  { cat: 'facility', name: 'Memorial Service', desc: 'Use of facilities (no body present)', price: 700 },
  { cat: 'facility', name: 'Graveside Service', desc: 'Equipment + chairs + tent', price: 550 },
  { cat: 'transportation', name: 'Transfer of Remains (local)', desc: 'Within 25 miles', price: 550 },
  { cat: 'transportation', name: 'Additional Mileage', desc: 'Per mile over 25', price: 5 },
  { cat: 'transportation', name: 'Hearse (service)', desc: 'To cemetery/crematory', price: 450 },
  { cat: 'transportation', name: 'Family Car (limousine)', desc: 'Up to 3 hours', price: 450 },
  { cat: 'casket', name: 'Bronze Casket - Standard', desc: '18-gauge steel, velvet interior', price: 2995 },
  { cat: 'casket', name: 'Wood Casket - Oak', desc: 'Solid oak, crepe interior', price: 3995 },
  { cat: 'casket', name: 'Wood Casket - Mahogany', desc: 'Premium mahogany, velvet interior', price: 5495 },
  { cat: 'casket', name: 'Steel Casket - Economy', desc: '20-gauge steel', price: 1995 },
  { cat: 'container', name: 'Concrete Burial Vault', desc: 'Standard', price: 1495 },
  { cat: 'container', name: 'Steel Burial Vault', desc: 'Premium', price: 2495 },
  { cat: 'container', name: 'Cremation Container (cardboard)', desc: 'Alternative container', price: 195 },
  { cat: 'container', name: 'Cremation Container (wood)', desc: 'Wood veneer', price: 495 },
  { cat: 'cremation', name: 'Direct Cremation', desc: 'Basic cremation without service', price: 995 },
  { cat: 'cremation', name: 'Cremation with Visitation', desc: 'Viewing + cremation', price: 2995 },
  { cat: 'cremation', name: 'Urn - Basic', desc: 'Standard cremation urn', price: 295 },
  { cat: 'cremation', name: 'Urn - Premium', desc: 'Solid brass or wood urn', price: 795 },
  { cat: 'cemetery', name: 'Cemetery Opening & Closing', desc: 'Standard interment', price: 1200 },
  { cat: 'cemetery', name: 'Entombment (Mausoleum)', desc: 'Mausoleum placement', price: 1500 },
  { cat: 'cemetery', name: 'Columbarium Niche', desc: 'Urn placement', price: 800 },
  { cat: 'merchandise', name: 'Memorial Register Book', desc: 'Hardcover', price: 75 },
  { cat: 'merchandise', name: 'Memorial Prayer Cards (100)', desc: 'Custom printed', price: 95 },
  { cat: 'merchandise', name: 'Acknowledgment Cards (50)', desc: 'Thank-you cards', price: 55 },
  { cat: 'merchandise', name: 'Keepsake Urn Pendant', desc: 'Miniature keepsake', price: 150 },
];

const DEFAULT_PRICING_PACKAGES = [
  { name: 'Traditional Burial', desc: 'Full-service traditional burial with visitation, chapel ceremony, and graveside', price: 8995 },
  { name: 'Simple Cremation', desc: 'Direct cremation with basic container', price: 1495 },
  { name: 'Cremation with Memorial', desc: 'Cremation with memorial service', price: 4495 },
  { name: 'Green Burial', desc: 'Natural burial with biodegradable container', price: 3995 },
];

function ensureDefaultPricing(organizationId = DEFAULT_ORG_ID) {
  const itemExists = db.prepare(`SELECT id FROM pricing_items WHERE organization_id = ? AND category = ? AND name = ?`);
  const insertItem = db.prepare(`INSERT INTO pricing_items (id, organization_id, category, name, description, price) VALUES (?, ?, ?, ?, ?, ?)`);
  const packageExists = db.prepare(`SELECT id FROM pricing_packages WHERE organization_id = ? AND name = ?`);
  const insertPackage = db.prepare(`INSERT INTO pricing_packages (id, organization_id, name, description, total_price) VALUES (?, ?, ?, ?, ?)`);
  let created = 0;
  const tx = db.transaction(() => {
    for (const item of DEFAULT_PRICING_ITEMS) {
      if (!itemExists.get(organizationId, item.cat, item.name)) {
        insertItem.run(uuidv4(), organizationId, item.cat, item.name, item.desc, item.price);
        created++;
      }
    }
    for (const pkg of DEFAULT_PRICING_PACKAGES) {
      if (!packageExists.get(organizationId, pkg.name)) {
        insertPackage.run(uuidv4(), organizationId, pkg.name, pkg.desc, pkg.price);
        created++;
      }
    }
  });
  tx();
  return created;
}

function seedPricing() {
  const orgs = db.prepare('SELECT id FROM organizations').all();
  let created = 0;
  for (const org of orgs) created += ensureDefaultPricing(org.id);
  if (created) console.log(`✅ Seeded ${created} default pricing items/packages`);
}
seedPricing();

// ── Seed admin user ──────────────────────────────────────
function seedUsers() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (cnt === 0) {
    const adminHash = hashPassword(DEFAULT_ADMIN_PASSWORD);
    db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), DEFAULT_ORG_ID, 'admin@funeralhome.com', 'Admin', 'admin', adminHash);
    db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), DEFAULT_ORG_ID, 'director@funeralhome.com', 'Director', 'director', adminHash);
    db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), DEFAULT_ORG_ID, 'staff@funeralhome.com', 'Staff', 'staff', adminHash);
    console.log('✅ Seeded default users (admin@funeralhome.com, director@funeralhome.com, staff@funeralhome.com)');
    return;
  }

  const usersWithoutPasswords = db.prepare(`SELECT id FROM users WHERE password_hash IS NULL OR password_hash = ''`).all();
  if (usersWithoutPasswords.length) {
    const defaultHash = hashPassword(DEFAULT_ADMIN_PASSWORD);
    const upd = db.prepare(`UPDATE users SET password_hash = ?, organization_id = COALESCE(organization_id, ?) WHERE id = ?`);
    for (const u of usersWithoutPasswords) upd.run(defaultHash, DEFAULT_ORG_ID, u.id);
    console.log(`✅ Added login password to ${usersWithoutPasswords.length} existing users`);
  }
}
seedUsers();

function seedBilling() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM billing_accounts').get().c;
  if (cnt > 0) return;
  db.prepare(`INSERT INTO billing_accounts (id, account_name, balance) VALUES (?, ?, ?)`)
    .run('default', 'Default Customer', 0);
  console.log('✅ Seeded default billing account');
}
seedBilling();

// ═══════════════════════════════════════════════════════════
// PART 2 — LLM Config
// ═══════════════════════════════════════════════════════════

const LLM_PROVIDER = process.env.LLM_PROVIDER || 'openai';
const LLM_MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
const openai = new OpenAI({
  apiKey: LLM_PROVIDER === 'deepseek'
    ? process.env.DEEPSEEK_API_KEY
    : (process.env.OPENAI_API_KEY || ''),
  baseURL: LLM_PROVIDER === 'deepseek' ? 'https://api.deepseek.com' : undefined,
});

// ═══════════════════════════════════════════════════════════
// PART 3 — Middleware
// ═══════════════════════════════════════════════════════════

app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (FORCE_HTTPS && req.protocol !== 'https' && req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/billing/stripe/webhook') req.rawBody = Buffer.from(buf);
  }
}));
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests' } });
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

function publicApiPath(pathname, method = 'GET') {
  return pathname === '/auth/login'
    || pathname === '/auth/register'
    || pathname === '/auth/logout'
    || pathname === '/billing/stripe/webhook'
    || (method === 'GET' && pathname.startsWith('/memorials/') && !pathname.includes('/messages'))
    || (method === 'POST' && /^\/memorials\/[^/]+\/messages$/.test(pathname))
    || pathname === '/grief-resources';
}

function requireApiAuth(req, res, next) {
  if (publicApiPath(req.path, req.method)) return next();

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (ALLOW_SERVICE_TOKEN && AUTH_TOKEN && token === AUTH_TOKEN) {
    req.user = { id: 'system', email: 'system', name: 'System', role: 'admin' };
    req.organizationId = req.headers['x-organization-id'] || DEFAULT_ORG_ID;
    req.organization = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.organizationId);
    return next();
  }

  if (!token) return res.status(401).json({ error: 'Sign in required' });
  const session = db.prepare(`
    SELECT s.*, u.email, u.name, u.role, u.active, o.name as organization_name, o.status as organization_status, o.plan_id
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND u.active = 1
  `).get(token);
  if (!session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  if (['suspended','cancelled'].includes(session.organization_status)) {
    return res.status(402).json({ error: 'Account is not active. Contact support.' });
  }
  req.sessionToken = token;
  req.organizationId = session.organization_id;
  req.user = { id: session.user_id, email: session.email, name: session.name, role: session.role };
  req.organization = {
    id: session.organization_id,
    name: session.organization_name,
    status: session.organization_status,
    planId: session.plan_id
  };
  next();
}

app.use('/api', requireApiAuth);

// Helper: audit log
function audit(userId, action, entityType, entityId, details = '', organizationId = DEFAULT_ORG_ID) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id, organization_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId || 'system', organizationId || DEFAULT_ORG_ID, action, entityType, entityId || null, details);
  } catch (e) { /* silent */ }
}

// Helper: add timeline entry
function addTimeline(caseId, status, note, userId) {
  db.prepare(`INSERT INTO case_timeline (case_id, status, note, created_by) VALUES (?, ?, ?, ?)`)
    .run(caseId, status, note || '', userId || null);
  db.prepare(`UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, caseId);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function getOrgPlan(organizationId) {
  return db.prepare(`
    SELECT p.*, o.ai_credit_balance, o.status
    FROM organizations o
    JOIN subscription_plans p ON p.id = o.plan_id
    WHERE o.id = ?
  `).get(organizationId);
}

function monthlyUsage(organizationId, eventType, month = currentMonth()) {
  return db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as qty
    FROM usage_events
    WHERE organization_id = ? AND event_type = ? AND strftime('%Y-%m', created_at) = ?
  `).get(organizationId, eventType, month).qty;
}

function dailyUsage(organizationId, eventType, day = new Date().toISOString().slice(0, 10)) {
  return db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as qty
    FROM usage_events
    WHERE organization_id = ? AND event_type = ? AND date(created_at) = ?
  `).get(organizationId, eventType, day).qty;
}

function recordUsage(organizationId, userId, eventType, quantity = 1, entityType = '', entityId = '', metadata = {}) {
  db.prepare(`INSERT INTO usage_events (id, organization_id, user_id, event_type, quantity, entity_type, entity_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), organizationId, userId || null, eventType, quantity, entityType, entityId || '', JSON.stringify(metadata || {}));
}

function chargeOverageIfNeeded(organizationId, eventType, quantity = 1) {
  const plan = getOrgPlan(organizationId);
  if (!plan) return;
  const limit = eventType === 'case_created' ? plan.included_cases : plan.included_ai_documents;
  const price = eventType === 'case_created' ? plan.overage_case_price : plan.overage_document_price;
  const usedBefore = monthlyUsage(organizationId, eventType);
  const overageQty = Math.max(0, usedBefore + quantity - limit) - Math.max(0, usedBefore - limit);
  const charge = overageQty * price;
  if (charge <= 0) return;

  const billing = db.prepare('SELECT id, balance FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(organizationId);
  const balance = billing?.balance || 0;
  if (balance < charge) {
    throw new Error(`Monthly plan limit reached. Recharge at least $${(charge - balance).toFixed(2)} to continue.`);
  }
  db.prepare(`UPDATE billing_accounts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?`)
    .run(charge, billing.id);
}

function ensureAiDocumentQuota(organizationId, quantity = 1) {
  const usedToday = dailyUsage(organizationId, 'ai_document_generated');
  if (usedToday + quantity > AI_DAILY_DOCUMENT_LIMIT) {
    throw new Error(`Daily AI document limit reached (${AI_DAILY_DOCUMENT_LIMIT}). Try again tomorrow or raise AI_DAILY_DOCUMENT_LIMIT.`);
  }
  const usedMonth = monthlyUsage(organizationId, 'ai_document_generated');
  if (usedMonth + quantity > AI_MONTHLY_DOCUMENT_HARD_LIMIT) {
    throw new Error(`Monthly AI document hard limit reached (${AI_MONTHLY_DOCUMENT_HARD_LIMIT}). Raise AI_MONTHLY_DOCUMENT_HARD_LIMIT after reviewing usage.`);
  }
}

function withAIReviewNotice(content) {
  if (!content) return AI_REVIEW_NOTICE;
  if (content.includes(AI_REVIEW_NOTICE)) return content;
  return `${AI_REVIEW_NOTICE}\n\n${content}`;
}

function ensureCaseAccess(caseId, organizationId) {
  return db.prepare('SELECT id FROM cases WHERE id = ? AND organization_id = ?').get(caseId, organizationId);
}

async function stripeRequest(endpoint, params) {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') body.append(key, String(value));
  }
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Stripe request failed: ${res.status}`);
  return data;
}

function stripeTimestampToIso(value) {
  if (!value) return '';
  return new Date(Number(value) * 1000).toISOString();
}

function mapStripeSubscriptionStatus(status) {
  if (['active', 'trialing'].includes(status)) return 'active';
  if (['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'].includes(status)) return 'past_due';
  if (['canceled', 'cancelled'].includes(status)) return 'cancelled';
  return 'trial';
}

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');
  const parts = Object.fromEntries(signatureHeader.split(',').map(part => {
    const [key, ...rest] = part.split('=');
    return [key, rest.join('=')];
  }));
  const timestamp = parts.t;
  const signatures = signatureHeader.split(',').filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  if (!timestamp || !signatures.length) throw new Error('Invalid Stripe-Signature header');
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error('Stripe webhook timestamp outside tolerance');
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto
    .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');
  return signatures.some(sig => {
    const sigBuffer = Buffer.from(sig, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  });
}

function findOrganizationForStripeObject(obj = {}) {
  const metadataOrg = obj.metadata?.organization_id || obj.client_reference_id;
  if (metadataOrg) return db.prepare('SELECT * FROM organizations WHERE id = ?').get(metadataOrg);
  if (obj.subscription) {
    const org = db.prepare('SELECT * FROM organizations WHERE stripe_subscription_id = ?').get(obj.subscription);
    if (org) return org;
  }
  if (obj.id && String(obj.object || '').includes('subscription')) {
    const org = db.prepare('SELECT * FROM organizations WHERE stripe_subscription_id = ?').get(obj.id);
    if (org) return org;
  }
  if (obj.customer) {
    return db.prepare('SELECT * FROM organizations WHERE stripe_customer_id = ?').get(obj.customer);
  }
  return null;
}

function syncOrganizationFromStripeCheckout(session) {
  const orgId = session.metadata?.organization_id || session.client_reference_id;
  const planId = session.metadata?.plan_id;
  if (!orgId || !planId) return false;
  db.prepare(`UPDATE organizations
    SET plan_id = ?, status = 'active',
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        updated_at = datetime('now')
    WHERE id = ?`)
    .run(planId, session.customer || null, session.subscription || null, orgId);
  audit('stripe', 'stripe_checkout_completed', 'organization', orgId, `Checkout session ${session.id}`, orgId);
  return true;
}

function syncOrganizationFromStripeSubscription(subscription) {
  const org = findOrganizationForStripeObject(subscription);
  if (!org) return false;
  const status = mapStripeSubscriptionStatus(subscription.status);
  db.prepare(`UPDATE organizations
    SET status = ?,
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        subscription_current_period_end = COALESCE(?, subscription_current_period_end),
        updated_at = datetime('now')
    WHERE id = ?`)
    .run(status, subscription.customer || null, subscription.id || null, stripeTimestampToIso(subscription.current_period_end) || null, org.id);
  audit('stripe', 'stripe_subscription_sync', 'organization', org.id, `Subscription ${subscription.id || ''} ${subscription.status || ''}`, org.id);
  return true;
}

function syncOrganizationFromStripeInvoice(invoice, status) {
  const org = findOrganizationForStripeObject(invoice);
  if (!org) return false;
  db.prepare(`UPDATE organizations SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, org.id);
  audit('stripe', 'stripe_invoice_sync', 'organization', org.id, `Invoice ${invoice.id || ''} ${status}`, org.id);
  return true;
}

function handleStripeWebhook(req, res) {
  try {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyStripeWebhookSignature(rawBody, req.headers['stripe-signature'])) {
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }
    const event = JSON.parse(rawBody.toString('utf8'));
    const obj = event.data?.object || {};
    let handled = false;

    if (event.type === 'checkout.session.completed') {
      handled = syncOrganizationFromStripeCheckout(obj);
    } else if (event.type === 'customer.subscription.updated') {
      handled = syncOrganizationFromStripeSubscription(obj);
    } else if (event.type === 'customer.subscription.deleted') {
      handled = syncOrganizationFromStripeSubscription({ ...obj, status: 'canceled' });
    } else if (event.type === 'invoice.paid') {
      handled = syncOrganizationFromStripeInvoice(obj, 'active');
    } else if (event.type === 'invoice.payment_failed') {
      handled = syncOrganizationFromStripeInvoice(obj, 'past_due');
    }

    res.json({ received: true, handled });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// PART 4 — AI Prompt Templates (US Market - Enhanced)
// ═══════════════════════════════════════════════════════════

const SYSTEM_PROMPTS = {
  obituary: `You are a professional funeral home assistant in the United States.
Write a respectful, dignified obituary following standard US format.
CRITICAL: Only include information explicitly provided. Do NOT fabricate names, dates, or any details.
Use proper US English spelling and formatting.
Tone options: "traditional" (standard newspaper style), "modern" (warmer, more personal), "religious" (faith-centered).
If a "tone" is provided, follow it. If "religious" is selected, include scripture references appropriate to the religion provided.
Include the standard sections: full name, age, residence, date of death, survived by, predeceased by,
education/career highlights, military service (if applicable), memberships/hobbies, service details.`,

  death_certificate: `You are a death certificate filing assistant in the United States.
Extract all available information and organize it into the standard US death certificate (Form US-43) sections.
Include: decedent's legal name, DOB, DOD, age, sex, race, ethnicity, residence, place of death,
marital status, surviving spouse, parents' names (mother's maiden), informant info,
method of disposition, funeral home, cause of death (as provided, do not invent).
IMPORTANT DISCLAIMER: This is a REFERENCE WORKSHEET only. The official death certificate must
be completed and signed by the attending physician, medical examiner, or coroner as required by state law.`,

  notifications: `You are a funeral home assistant. Generate a prioritized US notification checklist:
- Immediate family, employer
- Extended family, friends
- Professional contacts (attorney, accountant, financial advisor)
- Public notifications (newspaper - Legacy.com, social media)
- Organizational (clubs, unions, religious institutions)
- Government (Social Security Administration, VA, DMV, Passport Agency, Voter Registration)
- Insurance companies, pension providers, mortgage lender, credit cards, utilities
Only list categories relevant to the deceased's situation. Do NOT fabricate specific organizations.`,

  checklist: `You are a funeral home assistant in the United States. Generate a service planning checklist organized by timeline:

PREPARATION (before service):
- Document collection (will, insurance policies, birth certificate, marriage license, DD-214 for veterans)
- Death certificate orders (recommend 10-15 certified copies)
- Obituary submission to newspapers / Legacy.com
- Coordinate with cemetery / crematory
- Notify Social Security Administration (funeral home typically handles)

SERVICE PLANNING (1-7 days before):
- Visitation/viewing arrangements
- Eulogy/speaker coordination
- Music, readings, photo/video tributes
- Pallbearers, ushers
- Flower arrangements
- Reception planning
- Transportation (hearse, family car)

POST-SERVICE:
- Death certificate distribution
- Benefit claims (Social Security $255 lump sum, VA burial benefits, life insurance)
- Thank-you notes
- Memorial donation acknowledgments
- Grave marker / monument ordering

Tailor to the specific religious and cultural preferences provided.`,

  cremation_authorization: `You are a funeral home assistant in the United States.
Generate a cremation authorization form that includes the following standard elements:
- Authorizer's full name and relationship to deceased
- Statement that authorizer has legal authority to authorize cremation
- Deceased's identification details
- Method of disposition: cremation
- Crematory name and location
- Special instructions (religious, scattering, etc.)
- ID verification section
- Acknowledgment that cremation is irreversible
- Signature and date lines
Include this disclaimer: "I understand that cremation is an irreversible process. I certify that I am authorized to make this disposition decision under [State] law."`,

  ssa721: `You are a funeral home assistant in the United States. Generate a SSA-721 (Statement of Death by Funeral Director) reference worksheet.
Include: deceased's name, SSN, date of death, age, funeral home name and license number,
funeral director name and license, date of funeral home's notification to SSA.
This is a REFERENCE WORKSHEET. The funeral director must complete and submit the official SSA-721 form.`,

  va_benefits: `You are a funeral home assistant in the United States. Generate a VA burial benefits guide.
Include: eligibility criteria for veterans and spouses, what VA pays for (burial allowance up to $2,000,
plot allowance up to $1,000, transportation), how to apply (VA Form 21P-530EZ),
required documents (DD-214, death certificate, funeral bill), and timeline information.
This is a REFERENCE GUIDE only. Verify current VA benefit amounts as they change annually.`
};

async function callAI(systemPrompt, userContext, model = LLM_MODEL) {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContext }
    ],
    temperature: 0.3,
    max_tokens: 3000,
  });
  return response.choices[0].message.content;
}

function buildUserContext(deceased) {
  return Object.entries(deceased)
    .map(([k, v]) => `${k}: ${v || '(not provided)'}`)
    .join('\n');
}

function contentDispositionAttachment(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ═══════════════════════════════════════════════════════════
// PART 5 — API Routes: Users & Auth
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare(`
    SELECT u.*, o.name as organization_name, o.status as organization_status, o.plan_id
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
    WHERE lower(u.email) = lower(?) AND u.active = 1
  `).get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (['suspended','cancelled'].includes(user.organization_status)) {
    return res.status(402).json({ error: 'Account is not active. Contact support.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
  db.prepare(`INSERT INTO user_sessions (token, user_id, organization_id, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, user.id, user.organization_id, expiresAt);
  audit(user.id, 'login', 'user', user.id, 'User signed in', user.organization_id);
  res.json({
    token,
    expiresAt,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    organization: { id: user.organization_id, name: user.organization_name, status: user.organization_status, planId: user.plan_id }
  });
});

app.post('/api/auth/register', (req, res) => {
  const { organization_name, name, email, password, slug, plan_id } = req.body || {};
  const orgName = (organization_name || '').trim();
  const adminName = (name || '').trim();
  const adminEmail = (email || '').trim().toLowerCase();
  const adminPassword = (password || '').toString();
  const requestedPlan = plan_id || DEFAULT_PLAN_ID;

  if (!orgName || !adminName || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: 'Organization, name, email, and password are required' });
  }
  if (adminPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(adminEmail)) {
    return res.status(409).json({ error: 'Email is already registered' });
  }
  const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ? AND active = 1').get(requestedPlan);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const orgId = uuidv4();
  const userId = uuidv4();
  let orgSlug = normalizeSlug(slug || orgName);
  if (!orgSlug) orgSlug = `tenant-${orgId.slice(0, 8)}`;
  const baseSlug = orgSlug;
  let suffix = 2;
  while (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(orgSlug)) {
    orgSlug = `${baseSlug}-${suffix++}`.slice(0, 72);
  }

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, slug, status, plan_id) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, orgName, orgSlug, 'trial', requestedPlan);
    db.prepare('INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), orgId, orgName, 0);
    db.prepare('INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, orgId, adminEmail, adminName, 'admin', hashPassword(adminPassword));
    audit(userId, 'register', 'organization', orgId, `Registered ${orgName}`, orgId);
  });
  tx();
  ensureDefaultPricing(orgId);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
  db.prepare(`INSERT INTO user_sessions (token, user_id, organization_id, expires_at) VALUES (?, ?, ?, ?)`)
    .run(token, userId, orgId, expiresAt);

  res.json({
    token,
    expiresAt,
    user: { id: userId, email: adminEmail, name: adminName, role: 'admin' },
    organization: { id: orgId, name: orgName, status: 'trial', planId: requestedPlan }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token) db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(req.organization?.planId || DEFAULT_PLAN_ID);
  res.json({ user: req.user, organization: req.organization, plan });
});

app.get('/api/account', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.organizationId);
  const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(org.plan_id);
  const billing = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  res.json({ organization: org, plan, billing });
});

app.get('/api/account/plans', (req, res) => {
  res.json(db.prepare('SELECT * FROM subscription_plans WHERE active = 1 ORDER BY monthly_price').all());
});

app.get('/api/admin/plans', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  res.json(db.prepare('SELECT * FROM subscription_plans ORDER BY monthly_price').all());
});

app.put('/api/admin/plans/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const fields = ['name', 'monthly_price', 'included_cases', 'included_ai_documents', 'overage_case_price', 'overage_document_price', 'features', 'stripe_price_id', 'manual_payment_url', 'active'];
  const sets = [];
  const vals = [];
  for (const field of fields) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = ?`);
      vals.push(field === 'active' ? (req.body[field] ? 1 : 0) : req.body[field]);
    }
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE subscription_plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  audit(req.user.id, 'plan_pricing_update', 'subscription_plan', req.params.id, `Updated ${req.params.id}`, req.organizationId);
  res.json({ ok: true });
});

app.put('/api/account/plan', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { plan_id, status } = req.body;
  const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ? AND active = 1').get(plan_id);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  db.prepare(`UPDATE organizations SET plan_id = ?, status = COALESCE(?, status), updated_at = datetime('now') WHERE id = ?`)
    .run(plan_id, status || null, req.organizationId);
  audit(req.user.id, 'update_plan', 'organization', req.organizationId, `Plan changed to ${plan_id}`, req.organizationId);
  res.json({ ok: true });
});

app.post('/api/billing/stripe/checkout', async (req, res) => {
  try {
    if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
    const { plan_id } = req.body;
    const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ? AND active = 1').get(plan_id);
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });
    if (!plan.stripe_price_id) return res.status(400).json({ error: `Stripe price id is not configured for ${plan_id}` });

    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.organizationId);
    let customerId = org.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeRequest('customers', {
        email: req.user.email,
        name: org.name,
        'metadata[organization_id]': req.organizationId,
      });
      customerId = customer.id;
      db.prepare('UPDATE organizations SET stripe_customer_id = ?, updated_at = datetime("now") WHERE id = ?')
        .run(customerId, req.organizationId);
    }

    const session = await stripeRequest('checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': plan.stripe_price_id,
      'line_items[0][quantity]': 1,
      success_url: `${PUBLIC_BASE_URL}/?billing=success`,
      cancel_url: `${PUBLIC_BASE_URL}/?billing=cancelled`,
      'metadata[organization_id]': req.organizationId,
      'metadata[plan_id]': plan_id,
      client_reference_id: req.organizationId,
    });
    audit(req.user.id, 'stripe_checkout', 'organization', req.organizationId, `Checkout for ${plan_id}`, req.organizationId);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/stripe/webhook', handleStripeWebhook);

app.post('/api/billing/stripe/sync', async (req, res) => {
  const { plan_id, stripe_subscription_id, status, current_period_end } = req.body;
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ?').get(plan_id);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  db.prepare(`UPDATE organizations
    SET plan_id = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        status = COALESCE(?, status), subscription_current_period_end = COALESCE(?, subscription_current_period_end),
        updated_at = datetime('now')
    WHERE id = ?`)
    .run(plan_id, stripe_subscription_id || null, status || null, current_period_end || null, req.organizationId);
  audit(req.user.id, 'stripe_sync', 'organization', req.organizationId, `Synced ${plan_id}`, req.organizationId);
  res.json({ ok: true });
});

app.get('/api/usage', (req, res) => {
  const month = (req.query.month || new Date().toISOString().slice(0, 7)).toString();
  const rows = db.prepare(`
    SELECT event_type, COALESCE(SUM(quantity), 0) as qty
    FROM usage_events
    WHERE organization_id = ? AND strftime('%Y-%m', created_at) = ?
    GROUP BY event_type
  `).all(req.organizationId, month);
  const plan = db.prepare(`
    SELECT p.* FROM organizations o JOIN subscription_plans p ON p.id = o.plan_id WHERE o.id = ?
  `).get(req.organizationId);
  const usage = Object.fromEntries(rows.map(r => [r.event_type, r.qty]));
  res.json({ month, usage, plan });
});

app.get('/api/admin/status', (req, res) => {
  const orgCount = db.prepare('SELECT COUNT(*) as c FROM organizations').get().c;
  res.json({
    auth: {
      sessionAuth: true,
      serviceTokenEnabled: !!(ALLOW_SERVICE_TOKEN && AUTH_TOKEN),
    },
    tenant: {
      currentOrganizationId: req.organizationId,
      organizations: orgCount,
    },
    aiLimits: {
      dailyDocumentLimit: AI_DAILY_DOCUMENT_LIMIT,
      monthlyDocumentHardLimit: AI_MONTHLY_DOCUMENT_HARD_LIMIT,
    },
    security: {
      forceHttps: FORCE_HTTPS,
      httpsCertificateConfigured: !!(HTTPS_KEY_PATH && HTTPS_CERT_PATH),
    },
    stripe: {
      configured: !!STRIPE_SECRET_KEY,
      webhookConfigured: !!STRIPE_WEBHOOK_SECRET,
      priceIds: {
        starter: !!STRIPE_PRICE_STARTER,
        professional: !!STRIPE_PRICE_PROFESSIONAL,
        enterprise: !!STRIPE_PRICE_ENTERPRISE,
      },
    },
    legal: {
      privacy: '/privacy',
      terms: '/terms',
      disclaimer: '/disclaimer',
    },
  });
});

app.get('/api/platform/organizations', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  const orgs = db.prepare(`
    SELECT o.*, p.name as plan_name,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) as user_count,
      (SELECT COUNT(*) FROM cases c WHERE c.organization_id = o.id) as case_count
    FROM organizations o
    LEFT JOIN subscription_plans p ON p.id = o.plan_id
    ORDER BY o.created_at DESC
  `).all();
  res.json(orgs);
});

app.post('/api/platform/organizations', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  const { name, slug, plan_id, admin_email, admin_name, admin_password } = req.body;
  if (!name) return res.status(400).json({ error: 'Organization name required' });
  const orgId = uuidv4();
  const normalizedSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ?').get(plan_id || DEFAULT_PLAN_ID);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, slug, status, plan_id) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, name, normalizedSlug || orgId.slice(0, 8), 'trial', plan.id);
    db.prepare('INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), orgId, name, 0);
    if (admin_email) {
      db.prepare('INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), orgId, admin_email, admin_name || 'Admin', 'admin', hashPassword(admin_password || DEFAULT_ADMIN_PASSWORD));
    }
  });
  tx();
  ensureDefaultPricing(orgId);
  audit(req.user.id, 'create', 'organization', orgId, `Created organization ${name}`, req.organizationId);
  res.json({ id: orgId, name, slug: normalizedSlug, planId: plan.id });
});

app.get('/api/backups', (req, res) => {
  const backups = db.prepare('SELECT * FROM backups WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50').all(req.organizationId);
  res.json(backups);
});

app.post('/api/backups', async (req, res) => {
  try {
    if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
    const backupDir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const filename = `funeral_home_${req.organizationId}_${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const backupPath = path.join(backupDir, filename);
    await db.backup(backupPath);
    const id = uuidv4();
    db.prepare('INSERT INTO backups (id, organization_id, backup_type, path, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.organizationId, req.body?.backup_type || 'manual', backupPath, 'completed');
    audit(req.user.id, 'backup_created', 'backup', id, backupPath, req.organizationId);
    res.json({ id, path: backupPath, status: 'completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', (req, res) => {
  const users = db.prepare(`SELECT id, email, name, role, created_at, active FROM users WHERE organization_id = ? ORDER BY name`).all(req.organizationId);
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { email, name, role, password } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, organization_id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, req.organizationId, email, name, role || 'staff', hashPassword(password || DEFAULT_ADMIN_PASSWORD));
  audit(req.user.id, 'create', 'user', id, `Created user ${email}`, req.organizationId);
  res.json({ id, email, name, role });
});

app.put('/api/users/:id', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { name, role, active } = req.body;
  const u = db.prepare('SELECT id FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const updates = [];
  const vals = [];
  if (name !== undefined) { updates.push('name = ?'); vals.push(name); }
  if (role !== undefined) { updates.push('role = ?'); vals.push(role); }
  if (active !== undefined) { updates.push('active = ?'); vals.push(active ? 1 : 0); }
  if (updates.length > 0) {
    vals.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own user.' });
  const u = db.prepare('SELECT id, email, role FROM users WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.role === 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) as c FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1`).get(req.organizationId).c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Keep at least one active admin.' });
  }
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ? AND organization_id = ?').run(req.params.id, req.organizationId);
  audit(req.user.id, 'delete', 'user', req.params.id, `Deleted user ${u.email}`, req.organizationId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 6 — API Routes: Pricing (GPL / CPL / OBC / Packages)
// ═══════════════════════════════════════════════════════════

// Get all pricing items (grouped by category for GPL)
app.get('/api/pricing/items', (req, res) => {
  ensureDefaultPricing(req.organizationId);
  const items = db.prepare(`SELECT * FROM pricing_items WHERE active = 1 AND organization_id = ? ORDER BY category, name`).all(req.organizationId);
  res.json(items);
});

app.post('/api/pricing/items', (req, res) => {
  const { category, name, description, price, taxable } = req.body;
  if (!category || !name || price === undefined) return res.status(400).json({ error: 'category, name, price required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO pricing_items (id, organization_id, category, name, description, price, taxable) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.organizationId, category, name, description || '', price, taxable ? 1 : 0);
  audit(req.user.id, 'create', 'pricing_item', id, name, req.organizationId);
  res.json({ id, category, name, price });
});

app.put('/api/pricing/items/:id', (req, res) => {
  const item = db.prepare('SELECT id FROM pricing_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { name, description, price, category, active, taxable } = req.body;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (price !== undefined) { sets.push('price = ?'); vals.push(price); }
  if (category !== undefined) { sets.push('category = ?'); vals.push(category); }
  if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
  if (taxable !== undefined) { sets.push('taxable = ?'); vals.push(taxable ? 1 : 0); }
  if (sets.length) { vals.push(req.params.id, req.organizationId); db.prepare(`UPDATE pricing_items SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals); }
  res.json({ ok: true });
});

app.delete('/api/pricing/items/:id', (req, res) => {
  const item = db.prepare('SELECT id, name FROM pricing_items WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM case_selections WHERE item_id = ?').run(req.params.id);
  db.prepare('DELETE FROM package_items WHERE item_id = ?').run(req.params.id);
  db.prepare('DELETE FROM pricing_items WHERE id = ? AND organization_id = ?').run(req.params.id, req.organizationId);
  audit(req.user.id, 'delete', 'pricing_item', req.params.id, item.name, req.organizationId);
  res.json({ ok: true });
});

// Packages
app.get('/api/pricing/packages', (req, res) => {
  ensureDefaultPricing(req.organizationId);
  const pkgs = db.prepare(`SELECT * FROM pricing_packages WHERE active = 1 AND organization_id = ? ORDER BY name`).all(req.organizationId);
  for (const p of pkgs) {
    p.items = db.prepare(`SELECT pi.*, pkg_i.quantity FROM package_items pkg_i JOIN pricing_items pi ON pkg_i.item_id = pi.id WHERE pkg_i.package_id = ? AND pi.organization_id = ?`).all(p.id, req.organizationId);
  }
  res.json(pkgs);
});

app.post('/api/pricing/packages', (req, res) => {
  const { name, description, type, total_price, item_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO pricing_packages (id, organization_id, name, description, type, total_price) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, req.organizationId, name, description || '', type || 'at-need', total_price || 0);
  if (item_ids && Array.isArray(item_ids)) {
    const ins = db.prepare(`INSERT INTO package_items (id, package_id, item_id, quantity) VALUES (?, ?, ?, ?)`);
    for (const itemId of item_ids) {
      ins.run(uuidv4(), id, itemId, 1);
    }
  }
  audit(req.user.id, 'create', 'pricing_package', id, name, req.organizationId);
  res.json({ id, name });
});

app.put('/api/pricing/packages/:id', (req, res) => {
  const pkg = db.prepare('SELECT id FROM pricing_packages WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!pkg) return res.status(404).json({ error: 'Package not found' });
  const { name, description, total_price, active, item_ids } = req.body;
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (total_price !== undefined) { sets.push('total_price = ?'); vals.push(total_price); }
  if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
  if (sets.length) { vals.push(req.params.id, req.organizationId); db.prepare(`UPDATE pricing_packages SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals); }
  if (item_ids && Array.isArray(item_ids)) {
    db.prepare('DELETE FROM package_items WHERE package_id = ?').run(req.params.id);
    const ins = db.prepare(`INSERT INTO package_items (id, package_id, item_id, quantity) VALUES (?, ?, ?, ?)`);
    for (const itemId of item_ids) {
      ins.run(uuidv4(), req.params.id, itemId, 1);
    }
  }
  res.json({ ok: true });
});

app.delete('/api/pricing/packages/:id', (req, res) => {
  const pkg = db.prepare('SELECT id, name FROM pricing_packages WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (pkg) db.prepare('DELETE FROM package_items WHERE package_id = ?').run(req.params.id);
  db.prepare('DELETE FROM pricing_packages WHERE id = ? AND organization_id = ?').run(req.params.id, req.organizationId);
  if (pkg) audit(req.user.id, 'delete', 'pricing_package', req.params.id, pkg.name, req.organizationId);
  res.json({ ok: true });
});

// Billing / recharge
app.get('/api/billing', (req, res) => {
  let account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  if (!account) {
    db.prepare(`INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)`)
      .run(uuidv4(), req.organizationId, req.organization?.name || 'Customer', 0);
    account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  }
  const orders = db.prepare(`
    SELECT ro.*, sp.name as plan_name
    FROM recharge_orders ro
    LEFT JOIN subscription_plans sp ON sp.id = ro.plan_id
    WHERE ro.account_id = ?
    ORDER BY ro.created_at DESC
    LIMIT 50
  `).all(account.id);
  const payment = db.prepare(`SELECT payment_provider, payment_mode, payment_public_key, payment_instructions, payments_enabled,
    stripe_customer_id, stripe_subscription_id, subscription_current_period_end
    FROM organizations WHERE id = ?`).get(req.organizationId);
  res.json({ account, orders, payment });
});

app.post('/api/billing/recharge', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { amount, payment_method, note } = req.body;
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Valid recharge amount required' });
  }
  let account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  if (!account) {
    db.prepare(`INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)`)
      .run(uuidv4(), req.organizationId, req.organization?.name || 'Customer', 0);
    account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  }
  const id = uuidv4();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO recharge_orders (id, account_id, amount, payment_method, status, note) VALUES (?, ?, ?, ?, 'completed', ?)`)
      .run(id, account.id, numericAmount, payment_method || 'manual', note || '');
    db.prepare(`UPDATE billing_accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(numericAmount, account.id);
  });
  tx();
  audit(req.user.id, 'recharge', 'billing_account', account.id, `Recharge ${numericAmount}`, req.organizationId);
  res.json({ id, amount: numericAmount, status: 'completed' });
});

app.post('/api/billing/manual-checkout', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { plan_id } = req.body || {};
  const plan = db.prepare('SELECT * FROM subscription_plans WHERE id = ? AND active = 1').get(plan_id);
  if (!plan) return res.status(400).json({ error: 'Invalid plan' });
  let account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  if (!account) {
    db.prepare(`INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)`)
      .run(uuidv4(), req.organizationId, req.organization?.name || 'Customer', 0);
    account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  }
  const org = db.prepare(`SELECT payment_provider, payment_instructions FROM organizations WHERE id = ?`).get(req.organizationId) || {};
  const id = uuidv4();
  const amount = Number(plan.monthly_price || 0);
  const method = org.payment_provider && org.payment_provider !== 'stripe' ? org.payment_provider : 'manual_payment_link';
  const note = `Manual checkout requested for ${plan.name} (${plan.id}). Confirm payment before activating.`;
  db.prepare(`INSERT INTO recharge_orders (id, account_id, amount, plan_id, payment_method, status, note) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, account.id, amount, plan.id, method, note);
  audit(req.user.id, 'manual_checkout', 'recharge_order', id, `Requested ${plan.id}`, req.organizationId);
  res.json({
    id,
    amount,
    status: 'pending',
    plan_id: plan.id,
    plan_name: plan.name,
    url: plan.manual_payment_url || '',
    instructions: org.payment_instructions || ''
  });
});

app.put('/api/billing/settings', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const {
    payment_provider, payment_mode, payment_public_key, payment_instructions, payments_enabled,
    stripe_customer_id, stripe_subscription_id, subscription_current_period_end
  } = req.body || {};
  db.prepare(`UPDATE organizations
    SET payment_provider = COALESCE(?, payment_provider),
        payment_mode = COALESCE(?, payment_mode),
        payment_public_key = COALESCE(?, payment_public_key),
        payment_instructions = COALESCE(?, payment_instructions),
        payments_enabled = COALESCE(?, payments_enabled),
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        subscription_current_period_end = COALESCE(?, subscription_current_period_end),
        updated_at = datetime('now')
    WHERE id = ?`)
    .run(
      payment_provider || null,
      payment_mode || null,
      payment_public_key ?? null,
      payment_instructions ?? null,
      payments_enabled === undefined ? null : (payments_enabled ? 1 : 0),
      stripe_customer_id ?? null,
      stripe_subscription_id ?? null,
      subscription_current_period_end ?? null,
      req.organizationId
    );
  audit(req.user.id, 'billing_settings', 'organization', req.organizationId, 'Updated payment settings', req.organizationId);
  res.json({ ok: true });
});

app.post('/api/billing/adjust', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { amount, note } = req.body || {};
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) {
    return res.status(400).json({ error: 'Non-zero adjustment amount required' });
  }
  let account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  if (!account) {
    db.prepare(`INSERT INTO billing_accounts (id, organization_id, account_name, balance) VALUES (?, ?, ?, ?)`)
      .run(uuidv4(), req.organizationId, req.organization?.name || 'Customer', 0);
    account = db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ? ORDER BY created_at LIMIT 1').get(req.organizationId);
  }
  const id = uuidv4();
  const status = 'completed';
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO recharge_orders (id, account_id, amount, payment_method, status, note) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, account.id, numericAmount, 'admin_adjustment', status, note || 'Admin balance adjustment');
    db.prepare(`UPDATE billing_accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(numericAmount, account.id);
  });
  tx();
  audit(req.user.id, 'billing_adjustment', 'billing_account', account.id, `Adjustment ${numericAmount}`, req.organizationId);
  res.json({ id, amount: numericAmount, status });
});

app.put('/api/billing/recharge-orders/:id', (req, res) => {
  if (!['admin','director'].includes(req.user.role)) return res.status(403).json({ error: 'Admin or director role required' });
  const { amount, status, note } = req.body || {};
  const nextStatus = status || 'completed';
  if (!['pending','completed','failed','cancelled'].includes(nextStatus)) return res.status(400).json({ error: 'Invalid status' });
  const order = db.prepare(`SELECT ro.* FROM recharge_orders ro
    JOIN billing_accounts ba ON ba.id = ro.account_id
    WHERE ro.id = ? AND ba.organization_id = ?`).get(req.params.id, req.organizationId);
  if (!order) return res.status(404).json({ error: 'Recharge order not found' });
  const nextAmount = amount === undefined ? Number(order.amount || 0) : Number(amount);
  if (!Number.isFinite(nextAmount)) return res.status(400).json({ error: 'Valid amount required' });
  const previousBalanceAmount = order.status === 'completed' ? Number(order.amount || 0) : 0;
  const nextBalanceAmount = nextStatus === 'completed' ? nextAmount : 0;
  const delta = nextBalanceAmount - previousBalanceAmount;
  const tx = db.transaction(() => {
    db.prepare('UPDATE recharge_orders SET amount = ?, status = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(nextAmount, nextStatus, note ?? null, req.params.id);
    if (delta !== 0) {
      db.prepare(`UPDATE billing_accounts SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`)
        .run(delta, order.account_id);
    }
    if (nextStatus === 'completed' && order.plan_id) {
      const plan = db.prepare('SELECT id FROM subscription_plans WHERE id = ? AND active = 1').get(order.plan_id);
      if (plan) {
        db.prepare(`UPDATE organizations SET plan_id = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`)
          .run(order.plan_id, req.organizationId);
      }
    }
  });
  tx();
  audit(req.user.id, 'recharge_update', 'recharge_order', req.params.id, `Amount ${order.amount} -> ${nextAmount}, status ${order.status} -> ${nextStatus}`, req.organizationId);
  res.json({ ok: true });
});

// Generate GPL (General Price List) as text
app.get('/api/gpl', (req, res) => {
  const items = db.prepare(`SELECT * FROM pricing_items WHERE active = 1 AND organization_id = ? ORDER BY category, name`).all(req.organizationId);
  const byCat = {};
  for (const item of items) {
    if (!byCat[item.category]) byCat[item.category] = [];
    byCat[item.category].push(item);
  }
  const catLabels = { professional: 'Professional Services', facility: 'Facility & Staff', transportation: 'Transportation', casket: 'Caskets', container: 'Outer Burial Containers', cremation: 'Cremation Services', cemetery: 'Cemetery Services', merchandise: 'Merchandise', other: 'Other' };
  let gpl = `GENERAL PRICE LIST\n${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
  gpl += `This General Price List is required by the Federal Trade Commission's Funeral Rule.\nPrices are effective as of the date above.\n\n`;
  for (const [cat, catItems] of Object.entries(byCat)) {
    gpl += `${catLabels[cat] || cat}\n${'─'.repeat(40)}\n`;
    for (const item of catItems) {
      gpl += `  ${item.name.padEnd(55)} $${item.price.toFixed(2)}\n`;
      if (item.description) gpl += `    ${item.description}\n`;
    }
    gpl += '\n';
  }
  gpl += `\nIMPORTANT DISCLOSURES:\n`;
  gpl += `1. You have the right to choose only the goods and services you want.\n`;
  gpl += `2. You may purchase a casket from a third-party provider.\n`;
  gpl += `3. Embalming is not required by law except in certain special circumstances.\n`;
  gpl += `4. A casket is not required for direct cremation.\n`;
  gpl += `5. You have the right to an outer burial container from a third-party provider.\n`;
  gpl += `\nThis is a DRAFT generated by Funeral Home Agent. Verify all prices before use.\n`;
  res.json({ content: gpl, generatedAt: new Date().toISOString() });
});

// Generate Statement of Funeral Goods & Services Selected
app.get('/api/cases/:id/statement', (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);

  const selections = db.prepare(`
    SELECT cs.*, pi.name as item_name, pi.category, pi.description as item_desc
    FROM case_selections cs JOIN pricing_items pi ON cs.item_id = pi.id
    WHERE cs.case_id = ?
  `).all(req.params.id);

  let pkg = null;
  if (selections.length > 0 && selections[0].package_id) {
    pkg = db.prepare('SELECT * FROM pricing_packages WHERE id = ? AND organization_id = ?').get(selections[0].package_id, req.organizationId);
  }

  let stmt = `STATEMENT OF FUNERAL GOODS AND SERVICES SELECTED\n\n`;
  stmt += `Prepared for: ${di ? di.full_name : 'Deceased'}\n`;
  stmt += `Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
  stmt += `This statement itemizes the funeral goods and services you have selected.\n`;
  stmt += `You have the right to change your selection at any time before the service.\n\n`;
  stmt += `${'━'.repeat(60)}\n`;

  if (pkg) {
    stmt += `\nSELECTED PACKAGE: ${pkg.name}\n`;
    stmt += `Package Price: $${pkg.total_price.toFixed(2)}\n`;
  }

  if (selections.length > 0) {
    stmt += `\nITEMIZED SELECTIONS:\n${'─'.repeat(40)}\n`;
    let total = 0;
    for (const s of selections) {
      const lineTotal = s.price * s.quantity;
      stmt += `  ${s.item_name.padEnd(45)} $${lineTotal.toFixed(2)}\n`;
      if (s.quantity > 1) stmt += `    (${s.quantity} × $${s.price.toFixed(2)})\n`;
      total += lineTotal;
    }
    stmt += `\n  ${'─'.repeat(40)}\n`;
    stmt += `  ${'TOTAL:'.padEnd(45)} $${total.toFixed(2)}\n\n`;
  } else {
    stmt += `\n  No items selected yet.\n`;
  }

  stmt += `${'━'.repeat(60)}\n\n`;
  stmt += `CERTIFICATE OF COMPLIANCE WITH FTC FUNERAL RULE\n`;
  stmt += `I certify that the family/representative was offered a General Price List,\n`;
  stmt += `Casket Price List, and Outer Burial Container Price List prior to making selections.\n`;
  stmt += `No goods or services were bundled or required unless disclosed above.\n\n`;
  stmt += `Signature: ______________________________  Date: ______________\n`;
  stmt += `Funeral Director:\n\n`;
  stmt += `Signature: ______________________________  Date: ______________\n`;
  stmt += `Family/Representative:\n\n`;
  stmt += `DISCLAIMER: This is a DRAFT STATEMENT. Review all selections and prices for accuracy before signing.\n`;

  res.json({ content: stmt, selections, package: pkg });
});

// ═══════════════════════════════════════════════════════════
// PART 7 — API Routes: Case Management (with lifecycle)
// ═══════════════════════════════════════════════════════════

const VALID_STATUSES = ['first_call','removal','arrangement_pending','arrangement_done',
  'documents_generating','documents_ready','service_planned','service_in_progress','service_completed','post_service','closed'];
const STATUS_LABELS = {
  first_call: 'First Call', removal: 'Removal', arrangement_pending: 'Arrangement Scheduled',
  arrangement_done: 'Arrangement Done', documents_generating: 'Generating Documents',
  documents_ready: 'Documents Ready', service_planned: 'Service Planned',
  service_in_progress: 'Service In Progress', service_completed: 'Service Completed',
  post_service: 'Post-Service', closed: 'Closed'
};

function validateDeceased(data) {
  const errors = [];
  if (!data.fullName || data.fullName.trim().length === 0) errors.push('fullName is required');
  if (data.fullName && data.fullName.length > 2000) errors.push('fullName exceeds max length');
  if (data.dateOfDeath && !/^\d{4}-\d{2}-\d{2}$/.test(data.dateOfDeath)) errors.push('dateOfDeath must be YYYY-MM-DD');
  if (data.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(data.dateOfBirth) && data.dateOfBirth !== '') errors.push('dateOfBirth must be YYYY-MM-DD');
  return errors;
}

// List cases
app.get('/api/cases', (req, res) => {
  const cases = db.prepare(`
    SELECT c.id, c.status, c.created_at, c.updated_at, c.assigned_to, c.notes,
           d.full_name, d.date_of_death
    FROM cases c
    LEFT JOIN deceased_info d ON d.case_id = c.id
    WHERE c.organization_id = ?
    ORDER BY c.created_at DESC
  `).all(req.organizationId);
  res.json(cases.map(c => ({
    id: c.id, status: c.status, statusLabel: STATUS_LABELS[c.status] || c.status,
    createdAt: c.created_at, updatedAt: c.updated_at, assignedTo: c.assigned_to,
    deceased: { fullName: c.full_name || '', dateOfDeath: c.date_of_death || '' },
    notes: c.notes
  })));
});

app.get('/api/dashboard', (req, res) => {
  const totals = db.prepare(`SELECT status, COUNT(*) as cnt FROM cases WHERE organization_id = ? GROUP BY status`).all(req.organizationId);
  const today = new Date().toISOString().slice(0, 10);
  const todayCases = db.prepare(`SELECT COUNT(*) as cnt FROM cases WHERE organization_id = ? AND date(created_at) = ?`).get(req.organizationId, today);
  const openCases = db.prepare(`SELECT COUNT(*) as cnt FROM cases WHERE organization_id = ? AND status NOT IN ('closed','service_completed','post_service')`).get(req.organizationId);
  const totalCases = db.prepare(`SELECT COUNT(*) as cnt FROM cases WHERE organization_id = ?`).get(req.organizationId);
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(cs.price * cs.quantity), 0) as total FROM case_selections cs JOIN cases c ON c.id = cs.case_id WHERE c.organization_id = ?`).get(req.organizationId);
  const preNeeds = db.prepare(`SELECT COUNT(*) as cnt FROM pre_need_contracts WHERE organization_id = ? AND status = 'active'`).get(req.organizationId);
  const plan = getOrgPlan(req.organizationId);
  res.json({
    byStatus: Object.fromEntries(totals.map(r => [r.status, r.cnt])),
    todayCases: todayCases.cnt,
    openCases: openCases.cnt,
    totalCases: totalCases.cnt,
    totalRevenue: totalRevenue.total,
    activePreNeeds: preNeeds.cnt,
    plan: plan ? { name: plan.name, monthlyPrice: plan.monthly_price, includedCases: plan.included_cases, includedAiDocuments: plan.included_ai_documents } : null,
    usage: {
      cases: monthlyUsage(req.organizationId, 'case_created'),
      aiDocuments: monthlyUsage(req.organizationId, 'ai_document_generated')
    }
  });
});

// Create case
app.post('/api/cases', async (req, res) => {
  try {
    const { deceased } = req.body;
    const errors = validateDeceased(deceased);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    chargeOverageIfNeeded(req.organizationId, 'case_created', 1);
    const id = uuidv4();
    db.prepare(`INSERT INTO cases (id, organization_id, status, created_by) VALUES (?, ?, 'first_call', ?)`).run(id, req.organizationId, req.user.id);
    const diId = uuidv4();
    db.prepare(`INSERT INTO deceased_info (id, case_id${deceased.tone ? ', tone' : ''}) VALUES (?, ?${deceased.tone ? ', ?' : ''})`)
      .run(diId, id, ...(deceased.tone ? [deceased.tone] : []));

    // Update all fields
    const fieldMap = {
      fullName: 'full_name', age: 'age', dateOfBirth: 'date_of_birth', dateOfDeath: 'date_of_death',
      placeOfDeath: 'place_of_death', residence: 'residence', causeOfDeath: 'cause_of_death',
      sex: 'sex', maritalStatus: 'marital_status', occupation: 'occupation', education: 'education',
      spouse: 'spouse', children: 'children', grandchildren: 'grandchildren', predeceasedBy: 'predeceased_by',
      fatherName: 'father_name', motherName: 'mother_name', religion: 'religion',
      disposition: 'disposition', funeralHome: 'funeral_home', serviceDate: 'service_date',
      serviceLocation: 'service_location', visitation: 'visitation', burial: 'burial',
      militaryService: 'military_service', organizations: 'organizations', hobbies: 'hobbies',
      charities: 'charities', notes: 'notes', tone: 'tone'
    };
    const sets = []; const vals = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (deceased[key] !== undefined && deceased[key] !== null) {
        sets.push(`${col} = ?`);
        vals.push(deceased[key].toString());
      }
    }
    if (sets.length) {
      vals.push(diId);
      db.prepare(`UPDATE deceased_info SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    addTimeline(id, 'first_call', 'Case created', req.user.id);
    recordUsage(req.organizationId, req.user.id, 'case_created', 1, 'case', id);

    // Generate documents in background
    const caseData = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
    const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(id);
    const deceasedData = di || {};

    res.json({
      id, status: 'first_call', statusLabel: STATUS_LABELS['first_call'],
      deceased: mapDeceasedFields(di), documents: {}, timeline: []
    });

    // Start generating documents
    setImmediate(() => generateDocuments(id, deceasedData, req.organizationId, req.user.id));

  } catch (err) {
    console.error('Create case error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

function mapDeceasedFields(di) {
  if (!di) return {};
  const revMap = {
    full_name: 'fullName', age: 'age', date_of_birth: 'dateOfBirth', date_of_death: 'dateOfDeath',
    place_of_death: 'placeOfDeath', residence: 'residence', cause_of_death: 'causeOfDeath',
    sex: 'sex', marital_status: 'maritalStatus', occupation: 'occupation', education: 'education',
    spouse: 'spouse', children: 'children', grandchildren: 'grandchildren', predeceased_by: 'predeceasedBy',
    father_name: 'fatherName', mother_name: 'motherName', religion: 'religion',
    disposition: 'disposition', funeral_home: 'funeralHome', service_date: 'serviceDate',
    service_location: 'serviceLocation', visitation: 'visitation', burial: 'burial',
    military_service: 'militaryService', organizations: 'organizations', hobbies: 'hobbies',
    charities: 'charities', notes: 'notes', tone: 'tone'
  };
  const out = {};
  for (const [col, key] of Object.entries(revMap)) {
    out[key] = di[col] || '';
  }
  return out;
}

// Get single case (full detail)
app.get('/api/cases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);
  const docs = db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY doc_type').all(req.params.id);
  const timeline = db.prepare('SELECT * FROM case_timeline WHERE case_id = ? ORDER BY created_at ASC').all(req.params.id);
  const selections = db.prepare(`
    SELECT cs.*, pi.name as item_name, pi.category, pi.description as item_desc
    FROM case_selections cs LEFT JOIN pricing_items pi ON cs.item_id = pi.id
    WHERE cs.case_id = ?
  `).all(req.params.id);
  const cremationAuth = db.prepare('SELECT * FROM cremation_authorizations WHERE case_id = ? LIMIT 1').get(req.params.id);
  const memorial = db.prepare('SELECT * FROM memorials WHERE case_id = ? LIMIT 1').get(req.params.id);
  const preNeed = db.prepare('SELECT * FROM pre_need_contracts WHERE case_id = ? LIMIT 1').get(req.params.id);

  const docMap = {};
  for (const d of docs) {
    docMap[d.doc_type] = { content: d.content, status: d.status, error: d.error_msg };
  }

  res.json({
    id: c.id, status: c.status, statusLabel: STATUS_LABELS[c.status] || c.status,
    createdAt: c.created_at, updatedAt: c.updated_at, assignedTo: c.assigned_to,
    notes: c.notes,
    deceased: mapDeceasedFields(di),
    documents: docMap,
    timeline,
    selections,
    cremationAuthorization: cremationAuth || null,
    memorial: memorial || null,
    preNeedContract: preNeed || null,
  });
});

// Update case status (lifecycle)
app.put('/api/cases/:id/status', (req, res) => {
  const { status, note } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const c = ensureCaseAccess(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  addTimeline(req.params.id, status, note || STATUS_LABELS[status] || status, req.user.id);
  res.json({ status, statusLabel: STATUS_LABELS[status] });
});

// Update deceased info
app.put('/api/cases/:id', (req, res) => {
  const c = ensureCaseAccess(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const { deceased } = req.body;
  const di = db.prepare('SELECT id FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);
  if (!di) return res.status(400).json({ error: 'No deceased info record' });

  const fieldMap = {
    fullName: 'full_name', age: 'age', dateOfBirth: 'date_of_birth', dateOfDeath: 'date_of_death',
    placeOfDeath: 'place_of_death', residence: 'residence', causeOfDeath: 'cause_of_death',
    sex: 'sex', maritalStatus: 'marital_status', occupation: 'occupation', education: 'education',
    spouse: 'spouse', children: 'children', grandchildren: 'grandchildren', predeceasedBy: 'predeceased_by',
    fatherName: 'father_name', motherName: 'mother_name', religion: 'religion',
    disposition: 'disposition', funeralHome: 'funeral_home', serviceDate: 'service_date',
    serviceLocation: 'service_location', visitation: 'visitation', burial: 'burial',
    militaryService: 'military_service', organizations: 'organizations', hobbies: 'hobbies',
    charities: 'charities', notes: 'notes', tone: 'tone'
  };
  const sets = []; const vals = [];
  for (const [key, col] of Object.entries(fieldMap)) {
    if (deceased[key] !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(deceased[key].toString());
    }
  }
  if (sets.length) {
    vals.push(di.id);
    db.prepare(`UPDATE deceased_info SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  db.prepare(`UPDATE cases SET updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Delete case
app.delete('/api/cases/:id', (req, res) => {
  db.prepare('DELETE FROM cases WHERE id = ? AND organization_id = ?').run(req.params.id, req.organizationId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 8 — Document Generation
// ═══════════════════════════════════════════════════════════

async function generateDocuments(caseId, deceasedData, organizationId = DEFAULT_ORG_ID, userId = null) {
  const DOC_TYPES = [
    { type: 'obituary', key: 'obituary', label: 'Obituary' },
    { type: 'death_certificate', key: 'death_certificate', label: 'Death Certificate Info' },
    { type: 'notifications', key: 'notifications', label: 'Notification Checklist' },
    { type: 'checklist', key: 'checklist', label: 'Service Planning Checklist' },
  ];

  addTimeline(caseId, 'documents_generating', 'Generating AI documents', userId);

  for (const doc of DOC_TYPES) {
    const docId = uuidv4();
    db.prepare(`INSERT INTO documents (id, case_id, doc_type, content, status) VALUES (?, ?, ?, '', 'generating')`)
      .run(docId, caseId, doc.type);

    try {
      ensureAiDocumentQuota(organizationId, 1);
      chargeOverageIfNeeded(organizationId, 'ai_document_generated', 1);
      const userContext = buildUserContext(deceasedData);
      const content = withAIReviewNotice(await callAI(SYSTEM_PROMPTS[doc.type], userContext));
      db.prepare(`UPDATE documents SET content = ?, status = 'done', updated_at = datetime('now') WHERE id = ?`)
        .run(content, docId);
      recordUsage(organizationId, userId, 'ai_document_generated', 1, 'document', docId, { caseId, docType: doc.type });
    } catch (err) {
      console.error(`Error generating ${doc.type}:`, err.message);
      db.prepare(`UPDATE documents SET status = 'error', error_msg = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(err.message, docId);
    }
  }

  addTimeline(caseId, 'documents_ready', 'All documents generated', userId);
}

// Get documents for a case
app.get('/api/cases/:id/documents', (req, res) => {
  const c = ensureCaseAccess(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const docs = db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY doc_type').all(req.params.id);
  const docMap = {};
  for (const d of docs) {
    docMap[d.doc_type] = { content: d.content, status: d.status, error: d.error_msg };
  }
  res.json(docMap);
});

// Regenerate a single document
app.post('/api/cases/:id/regenerate', async (req, res) => {
  try {
    const { docType } = req.body;
    if (!SYSTEM_PROMPTS[docType]) return res.status(400).json({ error: 'Invalid docType' });
    const c = ensureCaseAccess(req.params.id, req.organizationId);
    if (!c) return res.status(404).json({ error: 'Case not found' });
    const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);
    if (!di) return res.status(400).json({ error: 'No deceased info' });

    ensureAiDocumentQuota(req.organizationId, 1);
    chargeOverageIfNeeded(req.organizationId, 'ai_document_generated', 1);
    const userContext = buildUserContext(di);
    const content = withAIReviewNotice(await callAI(SYSTEM_PROMPTS[docType], userContext));

    const existing = db.prepare('SELECT id FROM documents WHERE case_id = ? AND doc_type = ?').get(req.params.id, docType);
    if (existing) {
      db.prepare(`UPDATE documents SET content = ?, status = 'done', error_msg = NULL, updated_at = datetime('now') WHERE id = ?`).run(content, existing.id);
    } else {
      db.prepare(`INSERT INTO documents (id, case_id, doc_type, content, status) VALUES (?, ?, ?, ?, 'done')`).run(uuidv4(), req.params.id, docType, content);
    }
    recordUsage(req.organizationId, req.user.id, 'ai_document_generated', 1, 'case', req.params.id, { docType });
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update document content (manual edit)
app.put('/api/cases/:id/document', (req, res) => {
  const { docType, content } = req.body;
  if (!docType || content === undefined) return res.status(400).json({ error: 'docType and content required' });
  const c = ensureCaseAccess(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const existing = db.prepare('SELECT id FROM documents WHERE case_id = ? AND doc_type = ?').get(req.params.id, docType);
  if (existing) {
    db.prepare(`UPDATE documents SET content = ?, updated_at = datetime('now') WHERE id = ?`).run(content, existing.id);
  } else {
    db.prepare(`INSERT INTO documents (id, case_id, doc_type, content, status) VALUES (?, ?, ?, ?, 'done')`).run(uuidv4(), req.params.id, docType, content);
  }
  recordUsage(req.organizationId, req.user.id, 'manual_document_saved', 1, 'case', req.params.id, { docType });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 9 — Case Selections (pricing assignment)
// ═══════════════════════════════════════════════════════════

app.get('/api/cases/:id/selections', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const s = db.prepare(`
    SELECT cs.*, pi.name as item_name, pi.category, pi.description as item_desc, pi.price as current_price
    FROM case_selections cs JOIN pricing_items pi ON cs.item_id = pi.id
    WHERE cs.case_id = ?
  `).all(req.params.id);
  res.json(s);
});

app.post('/api/cases/:id/selections', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const { item_id, quantity, price } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });
  const id = uuidv4();
  const finalPrice = price !== undefined ? price : db.prepare('SELECT price FROM pricing_items WHERE id = ? AND organization_id = ?').get(item_id, req.organizationId)?.price || 0;
  db.prepare(`INSERT INTO case_selections (id, case_id, item_id, quantity, price) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.params.id, item_id, quantity || 1, finalPrice);
  res.json({ id });
});

app.delete('/api/cases/:id/selections/:selId', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  db.prepare('DELETE FROM case_selections WHERE id = ? AND case_id = ?').run(req.params.selId, req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 10 — Cremation Authorization
// ═══════════════════════════════════════════════════════════

app.get('/api/cases/:id/cremation-authorization', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const auth = db.prepare('SELECT * FROM cremation_authorizations WHERE case_id = ? LIMIT 1').get(req.params.id);
  res.json(auth || null);
});

app.post('/api/cases/:id/cremation-authorization', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const { authorizer_name, authorizer_relationship, authorizer_address, authorizer_phone,
    disposition_method, crematory_name, special_instructions, id_verified, id_type, id_number } = req.body;
  if (!authorizer_name) return res.status(400).json({ error: 'Authorizer name required' });

  const existing = db.prepare('SELECT id FROM cremation_authorizations WHERE case_id = ?').get(req.params.id);
  if (existing) {
    db.prepare(`UPDATE cremation_authorizations SET authorizer_name=?, authorizer_relationship=?, authorizer_address=?,
      authorizer_phone=?, disposition_method=?, crematory_name=?, special_instructions=?, id_verified=?, id_type=?, id_number=?
      WHERE id=?`).run(authorizer_name, authorizer_relationship || '', authorizer_address || '',
      authorizer_phone || '', disposition_method || 'cremation', crematory_name || '',
      special_instructions || '', id_verified ? 1 : 0, id_type || '', id_number || '', existing.id);
    return res.json({ id: existing.id });
  }

  const id = uuidv4();
  db.prepare(`INSERT INTO cremation_authorizations (id, case_id, authorizer_name, authorizer_relationship,
    authorizer_address, authorizer_phone, disposition_method, crematory_name, special_instructions,
    id_verified, id_type, id_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.params.id, authorizer_name, authorizer_relationship || '',
      authorizer_address || '', authorizer_phone || '', disposition_method || 'cremation',
      crematory_name || '', special_instructions || '', id_verified ? 1 : 0, id_type || '', id_number || '');
  res.json({ id });
});

app.put('/api/cases/:id/cremation-authorization/sign', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const auth = db.prepare('SELECT id FROM cremation_authorizations WHERE case_id = ?').get(req.params.id);
  if (!auth) return res.status(404).json({ error: 'No authorization found' });
  db.prepare(`UPDATE cremation_authorizations SET signed_at = datetime('now') WHERE id = ?`).run(auth.id);
  addTimeline(req.params.id, 'arrangement_done', 'Cremation authorization signed', req.user.id);
  res.json({ signedAt: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════
// PART 11 — Pre-Need Contracts
// ═══════════════════════════════════════════════════════════

app.get('/api/pre-need', (req, res) => {
  const contracts = db.prepare(`
    SELECT pn.*, pkg.name as package_name
    FROM pre_need_contracts pn
    LEFT JOIN pricing_packages pkg ON pn.package_id = pkg.id
    WHERE pn.organization_id = ?
    ORDER BY pn.created_at DESC
  `).all(req.organizationId);
  res.json(contracts);
});

app.post('/api/pre-need', (req, res) => {
  const { client_name, client_email, client_phone, package_id, total_amount, amount_paid, payment_plan, notes } = req.body;
  if (!client_name) return res.status(400).json({ error: 'Client name required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO pre_need_contracts (id, organization_id, client_name, client_email, client_phone, package_id, total_amount, amount_paid, payment_plan, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.organizationId, client_name, client_email || '', client_phone || '', package_id || null,
      total_amount || 0, amount_paid || 0, payment_plan || 'lump_sum', notes || '');
  audit(req.user.id, 'create', 'pre_need', id, `Pre-need for ${client_name}`, req.organizationId);
  res.json({ id, client_name });
});

app.put('/api/pre-need/:id', (req, res) => {
  const { status, amount_paid, notes } = req.body;
  const sets = []; const vals = [];
  if (status !== undefined) { sets.push('status = ?'); vals.push(status); }
  if (amount_paid !== undefined) { sets.push('amount_paid = ?'); vals.push(amount_paid); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
  if (sets.length) { vals.push(req.params.id, req.organizationId); db.prepare(`UPDATE pre_need_contracts SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals); }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 12 — Online Memorial / Guestbook
// ═══════════════════════════════════════════════════════════

app.post('/api/cases/:id/memorial', (req, res) => {
  const c = ensureCaseAccess(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);
  const { public_title, life_story } = req.body;
  const slug = (public_title || di?.full_name || 'memorial').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + req.params.id.slice(0, 8);
  const existing = db.prepare('SELECT id FROM memorials WHERE case_id = ?').get(req.params.id);
  if (existing) {
    db.prepare(`UPDATE memorials SET public_title=?, life_story=?, slug=? WHERE id=?`)
      .run(public_title || di?.full_name || '', life_story || '', slug, existing.id);
    return res.json({ id: existing.id, slug });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO memorials (id, case_id, slug, public_title, life_story) VALUES (?,?,?,?,?)`)
    .run(id, req.params.id, slug, public_title || di?.full_name || '', life_story || '');
  res.json({ id, slug });
});

app.get('/api/memorials', (req, res) => {
  const memorials = db.prepare(`
    SELECT m.*, d.full_name
    FROM memorials m
    JOIN cases c ON c.id = m.case_id
    LEFT JOIN deceased_info d ON d.case_id = m.case_id
    WHERE c.organization_id = ?
    ORDER BY m.created_at DESC
  `).all(req.organizationId);
  res.json(memorials);
});

app.get('/api/memorials/:slug', (req, res) => {
  const m = db.prepare(`
    SELECT m.*, d.full_name
    FROM memorials m
    LEFT JOIN deceased_info d ON d.case_id = m.case_id
    WHERE m.slug = ?
  `).get(req.params.slug);
  if (!m) return res.status(404).json({ error: 'Memorial not found' });
  if (!m.is_published) return res.status(404).json({ error: 'Memorial not published' });
  const messages = db.prepare('SELECT author_name, message, created_at FROM memorial_messages WHERE memorial_id = ? AND is_approved = 1 ORDER BY created_at DESC').all(m.id);
  res.json({ ...m, messages });
});

app.put('/api/memorials/:id/publish', (req, res) => {
  const { is_published } = req.body;
  db.prepare(`UPDATE memorials SET is_published = ? WHERE id = ? AND case_id IN (SELECT id FROM cases WHERE organization_id = ?)`)
    .run(is_published ? 1 : 0, req.params.id, req.organizationId);
  if (is_published) recordUsage(req.organizationId, req.user.id, 'memorial_published', 1, 'memorial', req.params.id);
  res.json({ ok: true });
});

app.post('/api/memorials/:id/messages', (req, res) => {
  const { author_name, message } = req.body;
  if (!author_name || !message) return res.status(400).json({ error: 'Name and message required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO memorial_messages (id, memorial_id, author_name, message) VALUES (?,?,?,?)`)
    .run(id, req.params.id, author_name, message);
  res.json({ id, autoApproved: false });
});

app.get('/api/memorials/:id/messages/pending', (req, res) => {
  const msgs = db.prepare(`SELECT * FROM memorial_messages WHERE memorial_id = ? AND is_approved = 0
    AND memorial_id IN (SELECT m.id FROM memorials m JOIN cases c ON c.id = m.case_id WHERE c.organization_id = ?)
    ORDER BY created_at`).all(req.params.id, req.organizationId);
  res.json(msgs);
});

app.put('/api/memorials/:id/messages/:msgId/approve', (req, res) => {
  db.prepare(`UPDATE memorial_messages SET is_approved = 1 WHERE id = ? AND memorial_id IN (
    SELECT m.id FROM memorials m JOIN cases c ON c.id = m.case_id WHERE c.organization_id = ?
  )`).run(req.params.msgId, req.organizationId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 13 — Inventory
// ═══════════════════════════════════════════════════════════

app.get('/api/inventory', (req, res) => {
  const items = db.prepare('SELECT * FROM inventory WHERE active = 1 AND organization_id = ? ORDER BY item_type, name').all(req.organizationId);
  res.json(items);
});

app.post('/api/inventory', (req, res) => {
  const { item_type, name, sku, description, quantity, reorder_level, supplier, cost_price, retail_price } = req.body;
  if (!item_type || !name) return res.status(400).json({ error: 'item_type and name required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO inventory (id, organization_id, item_type, name, sku, description, quantity, reorder_level, supplier, cost_price, retail_price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.organizationId, item_type, name, sku || '', description || '', quantity || 0, reorder_level || 5,
      supplier || '', cost_price || 0, retail_price || 0);
  audit(req.user.id, 'create', 'inventory', id, name, req.organizationId);
  res.json({ id, name });
});

app.put('/api/inventory/:id', (req, res) => {
  const { quantity, retail_price, cost_price, reorder_level, active, name } = req.body;
  const sets = []; const vals = [];
  if (quantity !== undefined) { sets.push('quantity = ?'); vals.push(quantity); }
  if (retail_price !== undefined) { sets.push('retail_price = ?'); vals.push(retail_price); }
  if (cost_price !== undefined) { sets.push('cost_price = ?'); vals.push(cost_price); }
  if (reorder_level !== undefined) { sets.push('reorder_level = ?'); vals.push(reorder_level); }
  if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (sets.length) { vals.push(req.params.id, req.organizationId); db.prepare(`UPDATE inventory SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals); }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 14 — Customer Support
// ═══════════════════════════════════════════════════════════

app.get('/api/support/tickets', (req, res) => {
  const tickets = db.prepare('SELECT * FROM support_tickets WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100').all(req.organizationId);
  res.json(tickets);
});

app.post('/api/support/tickets', (req, res) => {
  const { name, email, subject, message, topic, priority } = req.body;
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'name, email, subject, and message required' });
  }
  const id = uuidv4();
  db.prepare(`INSERT INTO support_tickets (id, organization_id, name, email, subject, message, topic, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.organizationId || DEFAULT_ORG_ID, name, email, subject, message, topic || 'Other', priority || 'Normal');
  audit(req.user?.id || 'system', 'create', 'support_ticket', id, subject, req.organizationId || DEFAULT_ORG_ID);
  res.json({ id, status: 'open' });
});

app.put('/api/support/tickets/:id', (req, res) => {
  const { status } = req.body;
  if (!['open', 'in_progress', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(status, req.params.id, req.organizationId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 15 — Audit Log
// ═══════════════════════════════════════════════════════════

app.get('/api/audit', (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100').all(req.organizationId);
  res.json(logs);
});

// ═══════════════════════════════════════════════════════════
// PART 16 — PDF Export (Enhanced)
// ═══════════════════════════════════════════════════════════

app.get('/api/cases/:id/pdf/:docType', async (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND organization_id = ?').get(req.params.id, req.organizationId);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const di = db.prepare('SELECT * FROM deceased_info WHERE case_id = ? LIMIT 1').get(req.params.id);

  const docMap = {
    obituary: 'Obituary',
    death_certificate: 'Death Certificate Info Sheet',
    notifications: 'Notification Checklist',
    checklist: 'Service Planning Checklist',
    cremation_authorization: 'Cremation Authorization',
    ssa721: 'SSA-721 Statement of Death',
    va_benefits: 'VA Burial Benefits Guide',
    gpl_statement: 'Statement of Funeral Goods & Services'
  };

  let content = '';
  if (req.params.docType === 'gpl_statement') {
    const stmtRes = await new Promise((resolve) => {
      const s = db.prepare(`
        SELECT cs.*, pi.name as item_name, pi.category, pi.description as item_desc
        FROM case_selections cs JOIN pricing_items pi ON cs.item_id = pi.id
        WHERE cs.case_id = ?
      `).all(req.params.id);
      let text = `STATEMENT OF FUNERAL GOODS AND SERVICES SELECTED\n\n`;
      text += `Prepared for: ${di ? di.full_name : 'Deceased'}\n\n`;
      let total = 0;
      for (const sel of s) {
        const lt = sel.price * sel.quantity;
        text += `${sel.item_name}: $${lt.toFixed(2)}\n`;
        total += lt;
      }
      text += `\nTOTAL: $${total.toFixed(2)}\n`;
      text += `\nCOMPLIANCE: The family was offered a General Price List prior to selection.\nNo goods or services were unlawfully bundled.\n`;
      resolve({ content: text });
    });
    content = stmtRes.content;
  } else {
    const doc = db.prepare('SELECT * FROM documents WHERE case_id = ? AND doc_type = ?').get(req.params.id, req.params.docType);
    content = doc ? doc.content : 'Document not found.';
  }

  const title = docMap[req.params.docType] || 'Document';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDispositionAttachment(`${di ? di.full_name : 'deceased'}-${req.params.docType}.pdf`));

  const pdf = new PDFDocument({ margin: 50, info: { Title: `${title} - ${di ? di.full_name : 'Deceased'}`, Author: 'Funeral Home Agent' } });
  pdf.pipe(res);

  // Watermark
  pdf.save();
  pdf.fontSize(48).font('Helvetica-Bold').fillColor('#eeeeee');
  pdf.text('DRAFT', pdf.page.width / 2 - 60, pdf.page.height / 2 - 20, { opacity: 0.3 });
  pdf.restore();

  // Header
  pdf.fontSize(20).font('Helvetica-Bold').fillColor('#1a1a1a').text(title, { align: 'center' });
  pdf.fontSize(12).font('Helvetica').fillColor('#444')
    .text(`Prepared for: ${di ? di.full_name : 'Deceased'}`, { align: 'center' }).moveDown(0.3);
  pdf.fontSize(9).fillColor('#888')
    .text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' })
    .fillColor('#1a1a1a').moveDown(1);

  // Disclaimer
  pdf.fontSize(8).fillColor('#cc4400')
    .text('DISCLAIMER: This document was AI-generated and is a DRAFT only. All information must be verified for accuracy before official use. Death certificates must be completed and signed by the appropriate medical professional as required by state law.', { align: 'center' })
    .fillColor('#1a1a1a').moveDown(1);

  pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ccc').stroke().moveDown(1);

  // Content
  pdf.fontSize(10).font('Helvetica');
  const lines = content.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) { pdf.moveDown(0.3); continue; }
    if (t.startsWith('**') && t.endsWith('**')) { pdf.font('Helvetica-Bold').fontSize(12).text(t.replace(/\*\*/g, '').trim()).font('Helvetica').fontSize(10); }
    else if (t.startsWith('#')) { pdf.font('Helvetica-Bold').fontSize(11).text(t.replace(/^#+\s*/, '').trim()).font('Helvetica').fontSize(10); }
    else { pdf.font('Helvetica').fontSize(10).text(t); }
  }

  pdf.moveDown(2);
  pdf.fontSize(7).fillColor('#aaa').text('Generated by Funeral Home Agent — DRAFT — Confidential', { align: 'center' });
  pdf.end();
});

// ═══════════════════════════════════════════════════════════
// PART 17 — Timeline & Notes
// ═══════════════════════════════════════════════════════════

app.get('/api/cases/:id/timeline', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const entries = db.prepare('SELECT * FROM case_timeline WHERE case_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json(entries);
});

app.post('/api/cases/:id/notes', (req, res) => {
  if (!ensureCaseAccess(req.params.id, req.organizationId)) return res.status(404).json({ error: 'Case not found' });
  const { notes } = req.body;
  db.prepare(`UPDATE cases SET notes = ?, updated_at = datetime('now') WHERE id = ? AND organization_id = ?`).run(notes || '', req.params.id, req.organizationId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// PART 18 — Grief Support Resources
// ═══════════════════════════════════════════════════════════

app.get('/api/grief-resources', (req, res) => {
  res.json({
    resources: [
      { name: 'GriefShare', url: 'https://www.griefshare.org', desc: 'Christian-based grief support groups and seminars' },
      { name: 'The Compassionate Friends', url: 'https://www.compassionatefriends.org', desc: 'Support for families after the death of a child' },
      { name: 'National Alliance for Grieving Children', url: 'https://childrengrieve.org', desc: 'Support for grieving children and families' },
      { name: 'Modern Loss', url: 'https://www.modernloss.com', desc: 'Online community for grief and loss' },
      { name: 'What\'s Your Grief', url: 'https://whatsyourgrief.com', desc: 'Online grief education and resources' },
      { name: 'SAMSHA Helpline', url: 'https://www.samhsa.gov/find-help/national-helpline', desc: '1-800-662-4357 — 24/7 crisis support' },
      { name: 'Veterans Crisis Line', url: 'https://www.veteranscrisisline.net', desc: '1-800-273-8255 (press 1) — support for veterans and families' },
    ]
  });
});

function legalPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>
    body{font-family:Inter,system-ui,-apple-system,sans-serif;max-width:820px;margin:0 auto;padding:48px 22px;line-height:1.65;color:#242735;background:#fff}
    h1{font-size:30px;margin-bottom:10px} h2{font-size:18px;margin-top:28px} p,li{font-size:14px;color:#4b5563} ul{padding-left:22px}
    .note{background:#fff8e1;border:1px solid #f0e0a0;border-radius:8px;padding:14px;margin:18px 0;color:#6b4f00}
    a{color:#4338ca}
  </style></head><body><h1>${escHtml(title)}</h1>${body}<h2>Contact</h2><p>For support, billing, privacy, or cancellation requests, contact <a href="mailto:${escHtml(SUPPORT_EMAIL)}">${escHtml(SUPPORT_EMAIL)}</a>.</p><p><a href="/">Return to app</a></p></body></html>`;
}

app.get('/privacy', (req, res) => {
  res.send(legalPage('Privacy Policy', `
    <p>Funeral Home Agent processes sensitive funeral home workflow information, including case details, family contact information, service preferences, pricing selections, support messages, billing status, audit events, and generated document drafts.</p>
    <h2>Data Use</h2><ul><li>Data is used to operate case management, AI document drafting, pricing, memorial, support, billing, backup, and audit features.</li><li>AI document generation sends the minimum necessary prompt context to the configured AI provider.</li><li>Funeral case data is not sold.</li></ul>
    <h2>Security</h2><ul><li>Production deployments should use HTTPS, strong staff passwords, restricted admin roles, database backups, access logs, and provider-level encryption.</li><li>Customers remain responsible for jurisdiction-specific retention, export, and privacy obligations.</li></ul>
    <div class="note">This starter policy is a product template, not legal advice. Have US counsel review it before launch.</div>
  `));
});

app.get('/terms', (req, res) => {
  res.send(legalPage('Terms of Service', `
    <p>These terms describe use of Funeral Home Agent as workflow software for funeral homes, crematories, and related staff.</p>
    <h2>Customer Responsibilities</h2><ul><li>Verify all generated documents before use.</li><li>Comply with the FTC Funeral Rule, state licensing rules, cremation authorization laws, privacy duties, and record retention requirements.</li><li>Maintain accurate General Price Lists and required disclosures.</li></ul>
    <h2>Subscriptions</h2><p>Stripe subscription checkout may be enabled by configuring Stripe keys and plan price identifiers. Invoice generation is not included in this version. See the refund and cancellation policy for billing rules.</p>
    <div class="note">This starter terms page is not legal advice. Review with counsel before commercial launch.</div>
  `));
});

app.get('/refund-policy', (req, res) => {
  res.send(legalPage('Refund and Cancellation Policy', `
    <p>Funeral Home Agent is offered as subscription software for professional funeral home workflow management.</p>
    <h2>Subscription Billing</h2><ul><li>Plans are billed monthly through the configured payment provider, typically Stripe Checkout.</li><li>Each plan includes stated monthly case and AI document allowances. Overages may be billed or deducted from account balance when enabled.</li><li>Prices, included usage, and overage rates are shown before checkout and may be updated for future billing periods.</li></ul>
    <h2>Cancellations</h2><ul><li>Customers may request cancellation through support or the account administrator workflow.</li><li>Cancellation stops future renewal charges after the current billing period unless otherwise agreed in writing.</li><li>Access may continue until the end of the paid billing period, subject to acceptable use and account standing.</li></ul>
    <h2>Refunds</h2><ul><li>Subscription fees are generally non-refundable once a billing period has started.</li><li>Refunds may be considered for duplicate charges, billing errors, or service availability issues confirmed by support.</li><li>Approved refunds are returned to the original payment method through the payment provider.</li></ul>
    <h2>Data Export</h2><p>Customers should export needed records before cancellation. Funeral homes remain responsible for record retention obligations under applicable law.</p>
    <div class="note">This starter policy is a product template, not legal advice. Have US counsel review it before launch.</div>
  `));
});

app.get('/disclaimer', (req, res) => {
  res.send(legalPage('AI and Compliance Disclaimer', `
    <p>${escHtml(AI_REVIEW_NOTICE)}</p>
    <h2>AI Output</h2><ul><li>AI-generated obituaries, checklists, worksheets, benefit guides, and authorizations are drafts only.</li><li>The system may omit, misunderstand, or misstate facts. Staff must verify every output against source records.</li></ul>
    <h2>Regulatory Notice</h2><ul><li>Death certificates must be completed and signed by authorized medical or legal officials as required by state law.</li><li>Funeral Rule pricing and disclosure obligations remain the funeral provider's responsibility.</li></ul>
  `));
});

// ═══════════════════════════════════════════════════════════
// PART 19 — Start
// ═══════════════════════════════════════════════════════════

function logStartup(protocol) {
  console.log(`\n🏰 Funeral Home Agent running on ${protocol}://localhost:${PORT}`);
  console.log(`📦  Database: ${DB_PATH}`);
  console.log('🔒  Session authentication enabled');
  if (ALLOW_SERVICE_TOKEN && AUTH_TOKEN) console.log('🔑  Service token enabled for automation');
  if (FORCE_HTTPS) console.log('🛡️  HTTPS redirect enabled behind proxy');
  if (LLM_PROVIDER === 'deepseek') {
    console.log(process.env.DEEPSEEK_API_KEY ? `✅  DeepSeek API key configured (${LLM_MODEL})` : '⚠️  DEEPSEEK_API_KEY not set');
  } else {
    console.log(process.env.OPENAI_API_KEY ? `✅  OpenAI API key configured (${LLM_MODEL})` : '⚠️  OPENAI_API_KEY not set');
  }
  console.log(`👥  Users: admin@funeralhome.com, director@funeralhome.com, staff@funeralhome.com`);
  console.log(`📋  Pricing: ${db.prepare('SELECT COUNT(*) as c FROM pricing_items').get().c} items, ${db.prepare('SELECT COUNT(*) as c FROM pricing_packages').get().c} packages`);
  console.log(`📁  Cases: ${db.prepare('SELECT COUNT(*) as c FROM cases').get().c} cases`);
  console.log();
}

const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || '';
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || '';
if (HTTPS_KEY_PATH && HTTPS_CERT_PATH && fs.existsSync(HTTPS_KEY_PATH) && fs.existsSync(HTTPS_CERT_PATH)) {
  https.createServer({
    key: fs.readFileSync(HTTPS_KEY_PATH),
    cert: fs.readFileSync(HTTPS_CERT_PATH),
  }, app).listen(PORT, () => logStartup('https'));
} else {
  app.listen(PORT, () => logStartup('http'));
}

// ── Public Memorial Page ────────────────────────────────────
app.get('/memorial/:slug', (req, res) => {
  const m = db.prepare(`SELECT m.*, d.full_name FROM memorials m LEFT JOIN deceased_info d ON d.case_id = m.case_id WHERE m.slug = ?`).get(req.params.slug);
  if (!m || !m.is_published) {
    return res.status(404).send('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h1>Memorial Not Found</h1><p>This memorial has not been published.</p></body></html>');
  }
  const messages = db.prepare('SELECT author_name, message, created_at FROM memorial_messages WHERE memorial_id = ? AND is_approved = 1 ORDER BY created_at DESC').all(m.id);
  const msgHtml = messages.map(msg => `<div class="msg"><strong>${escHtml(msg.author_name)}</strong><p>${escHtml(msg.message)}</p><div class="msg-time">${new Date(msg.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div></div>`).join('');
  const story = (m.life_story || '').split('\n').map(l => escHtml(l)).join('<br>');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(m.public_title || m.full_name)} — In Loving Memory</title><style>
    *{margin:0;padding:0;box-sizing:border-box}body{font-family:'Georgia',serif;background:#fafafa;color:#333;line-height:1.7;padding:40px 20px;max-width:700px;margin:auto}
    h1{font-size:28px;font-weight:400;text-align:center;margin-bottom:4px;color:#1a1a2e}
    .sub{text-align:center;color:#999;font-size:14px;margin-bottom:30px;font-style:italic}
    .story{font-size:15px;margin-bottom:30px;padding:20px;background:#fff;border:1px solid #eee;border-radius:8px}
    h2{font-size:18px;font-weight:400;margin-bottom:12px;color:#555}
    .msg{padding:12px 16px;border-bottom:1px solid #eee;background:#fff;border-radius:6px;margin-bottom:8px}
    .msg strong{font-size:13px;color:#555} .msg p{margin:4px 0;font-size:14px}
    .msg-time{font-size:11px;color:#bbb} .guestbook-form{margin:20px 0;padding:20px;background:#f5f5f7;border-radius:8px}
    .guestbook-form input,.guestbook-form textarea{width:100%;padding:8px 12px;margin:6px 0;border:1px solid #ddd;border-radius:5px;font-family:inherit;font-size:13px}
    .guestbook-form button{padding:8px 20px;background:#1a1a2e;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px}
    .footer{text-align:center;margin-top:40px;font-size:11px;color:#bbb;border-top:1px solid #eee;padding-top:16px}
  </style></head><body>
    <h1>${escHtml(m.public_title || m.full_name)}</h1><div class="sub">In Loving Memory</div>
    ${story ? `<div class="story">${story}</div>` : ''}
    <h2>Guestbook</h2>
    <div class="guestbook-form">
      <input type="text" id="gbName" placeholder="Your name" />
      <textarea id="gbMsg" rows="3" placeholder="Share a memory..."></textarea>
      <button onclick="sendMessage()">Leave a Message</button>
    </div>
    <div id="messages">${msgHtml}</div>
    <div class="footer">Powered by Funeral Home Agent</div>
    <script>
      async function sendMessage() {
        const name = document.getElementById('gbName').value.trim();
        const msg = document.getElementById('gbMsg').value.trim();
        if (!name || !msg) return alert('Please enter your name and message.');
        try {
          await fetch('/api/memorials/${m.id}/messages', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({author_name:name,message:msg}) });
          alert('Thank you. Your message has been submitted for approval.');
          document.getElementById('gbName').value = '';
          document.getElementById('gbMsg').value = '';
        } catch(e) { alert('Failed to send message.'); }
      }
    </script>
  </body></html>`);
});
