'use strict';
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { z } = require('zod');
const crypto = require('node:crypto');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 10 });
if (production) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '40kb' }));
const PgSession = connectPgSimple(session);
app.use(session({ store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }), name: 'fubs.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000 } }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '1h' : 0 }));

const registration = z.object({
  firstName: z.string().trim().min(1).max(80), middleName: z.string().trim().max(80).optional().default(''),
  lastName: z.string().trim().min(1).max(80), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.string().trim().max(40).optional().default(''), country: z.string().trim().min(2).max(80),
  stateRegion: z.string().trim().min(2).max(100), city: z.string().trim().min(2).max(100),
  residentialAddress: z.string().trim().min(5).max(250), postalCode: z.string().trim().max(20).optional().default(''),
  occupation: z.string().trim().max(100).optional().default(''), employmentStatus: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), phone: z.string().trim().min(7).max(25),
  password: z.string().min(12).max(128), transactionPin: z.string().regex(/^\d{6}$/), termsAccepted: z.literal(true)
});
function ageFrom(value) {
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return -1;
  const now = new Date(); let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
async function getUser(id) {
  const q = await pool.query(`SELECT u.id,u.first_name,u.middle_name,u.last_name,u.email,u.phone,u.date_of_birth::text AS date_of_birth,u.account_status,u.face_verification_status,u.email_verified_at,u.phone_verified_at,u.created_at,a.account_number FROM users u LEFT JOIN accounts a ON a.user_id=u.id WHERE u.id=$1`, [id]);
  return q.rows[0] || null;
}
function publicUser(u) {
  return { id:u.id, firstName:u.first_name, middleName:u.middle_name || '', lastName:u.last_name, fullName:[u.first_name,u.middle_name,u.last_name].filter(Boolean).join(' '), email:u.email, phone:u.phone, dateOfBirth:u.date_of_birth, accountNumber:u.account_number || null, accountStatus:u.account_status, faceVerificationStatus:u.face_verification_status, emailVerified:Boolean(u.email_verified_at), phoneVerified:Boolean(u.phone_verified_at), createdAt:u.created_at };
}
function auth(req,res,next) { if (!req.session.userId) return res.status(401).json({error:'Please sign in to continue.'}); next(); }
async function newAccountNumber(client,userId) {
  for (let i=0;i<5;i++) {
    const n=String(1000000000+crypto.randomInt(0,9000000000));
    try { await client.query("INSERT INTO accounts(user_id,account_number,status) VALUES($1,$2,'pending')",[userId,n]); return n; }
    catch(e) { if(e.code!=='23505') throw e; }
  }
  throw new Error('Could not allocate account number.');
}
app.get('/api/health', async (_req,res) => { try { await pool.query('SELECT 1'); res.json({status:'ok',database:'connected'}); } catch { res.status(503).json({status:'error',database:'unavailable'}); } });
app.get('/api/capabilities', (_req,res) => res.json({emailOtpDelivery:process.env.OTP_DELIVERY_ENABLED==='true',faceVerification:process.env.FACE_VERIFICATION_ENABLED==='true',realPayments:process.env.REAL_PAYMENTS_ENABLED==='true',notice:'Disabled integrations are not completed verification or real-money banking.'}));

app.post('/api/auth/register', async (req,res) => {
  const parsed=registration.safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:'Please check the registration details.',fields:parsed.error.issues.map(x=>({field:x.path.join('.'),message:x.message}))});
  const d=parsed.data;
  if(ageFrom(d.dateOfBirth)<18 || ageFrom(d.dateOfBirth)>120) return res.status(400).json({error:'Registration is currently limited to adults aged 18 or older.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicate=await client.query('SELECT id FROM users WHERE email=$1 OR phone=$2',[d.email,d.phone]);
    if(duplicate.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'An account using that email or phone already exists.'});}
    const passwordHash=await bcrypt.hash(d.password,12), pinHash=await bcrypt.hash(d.transactionPin,12);
    const created=await client.query(`INSERT INTO users(first_name,middle_name,last_name,date_of_birth,gender,country,state_region,city,residential_address,postal_code,occupation,employment_status,email,phone,password_hash,transaction_pin_hash,terms_accepted_at,face_verification_status,account_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),'not_configured','pending_review') RETURNING id`,[d.firstName,d.middleName||null,d.lastName,d.dateOfBirth,d.gender||null,d.country,d.stateRegion,d.city,d.residentialAddress,d.postalCode||null,d.occupation||null,d.employmentStatus||null,d.email,d.phone,passwordHash,pinHash]);
    const userId=created.rows[0].id;
    await newAccountNumber(client,userId);
    await client.query("INSERT INTO audit_events(actor_user_id,event_type,outcome,metadata) VALUES($1,'registration_created','pending',$2::jsonb)",[userId,JSON.stringify({email:d.email,faceVerification:'not_configured'})]);
    await client.query('COMMIT');
    await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
    req.session.userId=userId;
    const user=await getUser(userId);
    return res.status(201).json({message:'Registration received. Your account is pending verification and review.',user:publicUser(user),nextSteps:['Connect email verification.','Connect phone verification.','Configure a facial verification provider with liveness detection.','Complete compliance review and regulated banking-partner onboarding.']});
  } catch(e) { await client.query('ROLLBACK').catch(()=>{}); if(e.code==='23505') return res.status(409).json({error:'An account using those details already exists.'}); console.error('Registration error:',e.message); return res.status(500).json({error:'Registration could not be completed. Please try again.'}); }
  finally {client.release();}
});
app.post('/api/auth/login', async (req,res) => {
  const email=String(req.body.email||'').trim().toLowerCase(), password=String(req.body.password||'');
  if(!email||!password||email.length>254||password.length>128) return res.status(400).json({error:'Enter your email and password.'});
  try {
    const q=await pool.query('SELECT id,password_hash FROM users WHERE email=$1',[email]); const u=q.rows[0];
    if(!u || !(await bcrypt.compare(password,u.password_hash))) { await pool.query("INSERT INTO audit_events(event_type,outcome,metadata) VALUES('login','failed',$1::jsonb)",[JSON.stringify({email})]); return res.status(401).json({error:'Invalid email or password.'}); }
    await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve())); req.session.userId=u.id;
    await pool.query("INSERT INTO audit_events(actor_user_id,event_type,outcome) VALUES($1,'login','success')",[u.id]);
    return res.json({message:'Signed in successfully.',user:publicUser(await getUser(u.id))});
  } catch(e) { console.error('Login error:',e.message); res.status(500).json({error:'Unable to sign in right now.'}); }
});
app.post('/api/auth/logout',auth,(req,res)=>req.session.destroy(e=>{if(e)return res.status(500).json({error:'Could not sign out.'});res.clearCookie('fubs.sid',{httpOnly:true,secure:production,sameSite:'lax'});res.json({message:'Signed out.'});}));
app.get('/api/me',auth,async(req,res)=>{try{const u=await getUser(req.session.userId);if(!u)return res.status(404).json({error:'Account not found.'});res.json({user:publicUser(u)});}catch(e){console.error(e.message);res.status(500).json({error:'Could not load profile.'});}});
app.get('/api/transactions',activeAccount,async(req,res)=>{try{const q=await pool.query(`SELECT t.reference,t.type,t.amount_minor,t.currency,t.status,t.description,t.created_at FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.user_id=$1 ORDER BY t.created_at DESC LIMIT 100`,[req.session.userId]);res.json({transactions:q.rows.map(t=>({reference:t.reference,type:t.type,amountMinor:t.amount_minor,currency:t.currency,status:t.status,description:t.description,createdAt:t.created_at}))});}catch(e){console.error(e.message);res.status(500).json({error:'Could not load transactions.'});}});
app.post(
  '/api/admin/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  }),
  async (req, res) => {
    const configuredEmail = String(process.env.ADMIN_EMAIL || '')
      .trim()
      .toLowerCase();
    const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || '');

    if (!configuredEmail || !passwordHash.startsWith('$2')) {
      return res.status(503).json({
        error: 'Administrator login has not been configured correctly.'
      });
    }

    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password || password.length > 128) {
      return res.status(400).json({
        error: 'Enter the administrator email and password.'
      });
    }

    try {
      const matchesEmail = email === configuredEmail;
      const matchesPassword = await bcrypt.compare(
        password,
        passwordHash
      );

      if (!matchesEmail || !matchesPassword) {
        await pool.query(
          `INSERT INTO audit_events(event_type, outcome, metadata)
           VALUES ('admin_login', 'failed', $1::jsonb)`,
          [JSON.stringify({ email })]
        );

        return res.status(401).json({
          error: 'Invalid administrator email or password.'
        });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate(error =>
          error ? reject(error) : resolve()
        );
      });

      req.session.isAdmin = true;
      req.session.adminEmail = configuredEmail;

      await pool.query(
        `INSERT INTO audit_events(event_type, outcome, metadata)
         VALUES ('admin_login', 'success', $1::jsonb)`,
        [JSON.stringify({ adminEmail: configuredEmail })]
      );

      return res.json({
        message: 'Administrator signed in successfully.',
        email: configuredEmail
      });
    } catch (error) {
      console.error('Admin login error:', error.message);
      return res.status(500).json({
        error: 'Administrator sign-in failed. Please try again.'
      });
    }
  }
);

app.get('/api/admin/me', adminAuth, (req, res) => {
  res.json({
    email: req.session.adminEmail,
    authenticated: true
  });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  const adminEmail = req.session.adminEmail;

  req.session.destroy(async error => {
    if (error) {
      return res.status(500).json({
        error: 'Could not sign out.'
      });
    }

    res.clearCookie('fubs.sid', {
      httpOnly: true,
      secure: production,
      sameSite: 'lax'
    });

    try {
      await pool.query(
        `INSERT INTO audit_events(event_type, outcome, metadata)
         VALUES ('admin_logout', 'success', $1::jsonb)`,
        [JSON.stringify({ adminEmail })]
      );
    } catch (auditError) {
      console.error('Admin logout audit error:', auditError.message);
    }

    return res.json({ message: 'Administrator signed out.' });
  });
});

app.get('/api/admin/applications', adminAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.first_name,
         u.middle_name,
         u.last_name,
         u.email,
         u.phone,
         u.date_of_birth::text AS date_of_birth,
         u.gender,
         u.country,
         u.state_region,
         u.city,
         u.occupation,
         u.employment_status,
         u.account_status,
         u.face_verification_status,
         u.email_verified_at,
         u.phone_verified_at,
         u.created_at,
         a.account_number,
         a.status AS bank_account_status
       FROM users u
       JOIN accounts a ON a.user_id = u.id
       WHERE u.account_status = 'pending_review'
       ORDER BY u.created_at ASC
       LIMIT 200`
    );

    return res.json({
      applications: result.rows.map(row => ({
        id: row.id,
        firstName: row.first_name,
        middleName: row.middle_name || '',
        lastName: row.last_name,
        fullName: [
          row.first_name,
          row.middle_name,
          row.last_name
        ].filter(Boolean).join(' '),
        email: row.email,
        phone: row.phone,
        dateOfBirth: row.date_of_birth,
        gender: row.gender,
        country: row.country,
        stateRegion: row.state_region,
        city: row.city,
        occupation: row.occupation,
        employmentStatus: row.employment_status,
        accountStatus: row.account_status,
        accountNumber: row.account_number,
        bankAccountStatus: row.bank_account_status,
        faceVerificationStatus: row.face_verification_status,
        emailVerified: Boolean(row.email_verified_at),
        phoneVerified: Boolean(row.phone_verified_at),
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('Admin applications error:', error.message);
    return res.status(500).json({
      error: 'Could not load pending applications.'
    });
  }
});

app.post(
  '/api/admin/applications/:id/decision',
  adminAuth,
  async (req, res) => {
    const idResult = z.string().uuid().safeParse(req.params.id);

    const decisionSchema = z.object({
      action: z.enum(['approve', 'reject']),
      notes: z.string().trim().max(500).optional().default('')
    });

    const decisionResult = decisionSchema.safeParse(req.body);

    if (!idResult.success || !decisionResult.success) {
      return res.status(400).json({
        error: 'Provide a valid application ID and decision.'
      });
    }

    const { action, notes } = decisionResult.data;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const found = await client.query(
        `SELECT
           u.id,
           u.account_status,
           a.status AS bank_account_status
         FROM users u
         JOIN accounts a ON a.user_id = u.id
         WHERE u.id = $1
         FOR UPDATE OF u, a`,
        [idResult.data]
      );

      if (found.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'Application not found.'
        });
      }

      const application = found.rows[0];

      if (
        application.account_status !== 'pending_review' ||
        application.bank_account_status !== 'pending'
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This application is no longer pending review.'
        });
      }

      const userStatus = action === 'approve' ? 'active' : 'rejected';
      const accountStatus = action === 'approve' ? 'active' : 'closed';

      await client.query(
        'UPDATE users SET account_status = $1 WHERE id = $2',
        [userStatus, application.id]
      );

      await client.query(
        'UPDATE accounts SET status = $1 WHERE user_id = $2',
        [accountStatus, application.id]
      );

      await client.query(
        `INSERT INTO audit_events(
           actor_user_id,
           event_type,
           outcome,
           metadata
         )
         VALUES (NULL, $1, $2, $3::jsonb)`,
        [
          action === 'approve'
            ? 'application_approved'
            : 'application_rejected',
          action === 'approve' ? 'approved' : 'rejected',
          JSON.stringify({
            adminEmail: req.session.adminEmail,
            applicationId: application.id,
            notes
          })
        ]
      );

      await client.query('COMMIT');

      return res.json({
        message: action === 'approve'
          ? 'Application approved. The account is now active in this demo.'
          : 'Application rejected.',
        applicationId: application.id,
        accountStatus: userStatus,
        bankAccountStatus: accountStatus
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Application decision error:', error.message);

      return res.status(500).json({
        error: 'Could not process this decision. Please try again.'
      });
    } finally {
      client.release();
    }
  }
);

 // ============================================================
// DEMO DEPOSITS — SIMULATED FUNDS ONLY
// ============================================================

app.post('/api/demo-deposits', activeAccount, async (req, res) => {
  const amount = String(req.body.amountNaira ?? '').trim();

  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount)) {
    return res.status(400).json({
      error: 'Enter a valid amount, such as 50000 or 1500.50.'
    });
  }

  const [nairaPart, koboPart = ''] = amount.split('.');
  const amountMinor =
    BigInt(nairaPart) * 100n +
    BigInt(koboPart.padEnd(2, '0'));

  if (amountMinor <= 0n || amountMinor > 10000000000000n) {
    return res.status(400).json({
      error: 'Enter an amount between ₦0.01 and ₦100,000,000,000.00.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, currency
       FROM accounts
       WHERE user_id = $1 AND status = 'active'
       FOR UPDATE`,
      [req.session.userId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'An active bank account is required.'
      });
    }

    const account = result.rows[0];

    const reference =
      'DEMO-' + crypto.randomUUID().replace(/-/g, '').toUpperCase();

    const balanceResult = await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor + $1::bigint
       WHERE id = $2
       RETURNING balance_minor`,
      [amountMinor.toString(), account.id]
    );

    await client.query(
      `INSERT INTO transactions
       (reference, account_id, type, amount_minor, currency,
        status, description, idempotency_key, posted_at)
       VALUES ($1, $2, 'deposit', $3, $4, 'posted',
               'SIMULATED DEMO DEPOSIT', $5, NOW())`,
      [
        reference,
        account.id,
        amountMinor.toString(),
        account.currency.trim(),
        reference
      ]
    );

    await client.query(
      `INSERT INTO audit_events
       (actor_user_id, event_type, outcome, metadata)
       VALUES ($1, 'demo_deposit', 'success', $2::jsonb)`,
      [
        req.session.userId,
        JSON.stringify({
          reference,
          amountMinor: amountMinor.toString(),
          simulated: true
        })
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Demo money added successfully. No real money was deposited.',
      simulated: true,
      reference,
      amountMinor: amountMinor.toString(),
      balanceMinor: String(balanceResult.rows[0].balance_minor)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    console.error('Demo deposit error:', error.message);

    return res.status(500).json({
      error: 'Could not add demo money.'
    });
  } finally {
    client.release();
  }
});


// ============================================================
// ACCOUNT BALANCE
// ============================================================

app.get('/api/account', activeAccount, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         a.account_number,
         a.currency,
         a.status,
         a.balance_minor,
         a.updated_at
       FROM accounts a
       WHERE a.user_id = $1`,
      [req.session.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: 'Bank account not found.'
      });
    }

    const account = result.rows[0];

    res.json({
      accountNumber: account.account_number.trim(),
      currency: account.currency.trim(),
      status: account.status,
      balanceMinor: String(account.balance_minor),
      updatedAt: account.updated_at
    });
  } catch (error) {
    console.error('Account balance error:', error.message);

    res.status(500).json({
      error: 'Could not load account balance.'
    });
  }
});


// ============================================================
// ACCOUNT LOOKUP
// ============================================================

app.get(
  '/api/account/lookup/:accountNumber',
  activeAccount,
  async (req, res) => {
    try {
      const accountNumber = String(
        req.params.accountNumber || ''
      ).trim();

      if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({
          error: 'Enter a valid 10-digit account number.'
        });
      }

      const result = await pool.query(
        `SELECT
           a.account_number,
           u.first_name,
           u.middle_name,
           u.last_name
         FROM accounts a
         JOIN users u ON u.id = a.user_id
         WHERE a.account_number = $1
           AND a.status = 'active'
           AND u.account_status = 'active'`,
        [accountNumber]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: 'No eligible Fubs account was found.'
        });
      }

      const recipient = result.rows[0];

      res.json({
        accountNumber: recipient.account_number.trim(),
        accountName: [
          recipient.first_name,
          recipient.middle_name,
          recipient.last_name
        ].filter(Boolean).join(' ')
      });
    } catch (error) {
      console.error('Account lookup error:', error.message);

      res.status(500).json({
        error: 'Could not look up this account.'
      });
    }
  }
);


// ============================================================
// INTERNAL DEMO TRANSFER
// ============================================================

app.post('/api/transfers', activeAccount, async (req, res) => {
  const {
    recipientAccountNumber,
    amount,
    transactionPin,
    idempotencyKey
  } = req.body || {};

  const recipientNumber = String(
    recipientAccountNumber || ''
  ).trim();

  const amountText = String(amount ?? '').trim();

  const pin = String(transactionPin || '');

  const requestKey = String(idempotencyKey || '').trim();

  if (!/^\d{10}$/.test(recipientNumber)) {
    return res.status(400).json({
      error: 'Enter a valid 10-digit recipient account number.'
    });
  }

  if (!/^\d{1,10}(\.\d{1,2})?$/.test(amountText)) {
    return res.status(400).json({
      error: 'Enter an amount with no more than two decimal places.'
    });
  }

  const amountParts = amountText.split('.');
  const wholeNaira = BigInt(amountParts[0]);
  const kobo = BigInt(
    (amountParts[1] || '').padEnd(2, '0') || '0'
  );

  const amountMinor = wholeNaira * 100n + kobo;

  // Demo limit: maximum ₦100,000,000 per transfer.
  if (amountMinor < 1n || amountMinor > 10000000000n) {
    return res.status(400).json({
      error: 'Transfer amount must be between ₦0.01 and ₦100,000,000.00.'
    });
  }

  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({
      error: 'Enter your six-digit transaction PIN.'
    });
  }

  if (
    requestKey.length < 16 ||
    requestKey.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(requestKey)
  ) {
    return res.status(400).json({
      error: 'A valid transfer request key is required.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Load the sender and recipient and lock their account rows.
    // Consistent lock ordering helps prevent transfer deadlocks.
    const accountsResult = await client.query(
      `SELECT
         a.id,
         a.user_id,
         a.account_number,
         a.currency,
         a.status AS account_status,
         a.balance_minor,
         u.account_status AS user_status,
         u.transaction_pin_hash,
         u.first_name,
         u.middle_name,
         u.last_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.account_number = $1
          OR a.user_id = $2
       ORDER BY a.id
       FOR UPDATE OF a`,
      [recipientNumber, req.session.userId]
    );

    const sender = accountsResult.rows.find(
      account => account.user_id === req.session.userId
    );

    const recipient = accountsResult.rows.find(
      account => account.account_number.trim() === recipientNumber
    );

    if (!sender) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Your bank account could not be found.'
      });
    }

    if (!recipient) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Recipient account was not found.'
      });
    }

    if (sender.id === recipient.id) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'You cannot transfer money to your own account.'
      });
    }

    if (
      sender.account_status !== 'active' ||
      sender.user_status !== 'active'
    ) {
      await client.query('ROLLBACK');

      return res.status(403).json({
        error: 'Your account is not active.'
      });
    }

    if (
      recipient.account_status !== 'active' ||
      recipient.user_status !== 'active'
    ) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'The recipient account is not eligible for transfers.'
      });
    }

    if (sender.currency.trim() !== recipient.currency.trim()) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'The accounts must use the same currency.'
      });
    }

    // Verify the transaction PIN against its stored bcrypt hash.
    const pinMatches = await bcrypt.compare(
      pin,
      sender.transaction_pin_hash
    );

    if (!pinMatches) {
      await client.query('ROLLBACK');

      return res.status(401).json({
        error: 'Incorrect transaction PIN.'
      });
    }

    // A repeated request key must never create another transfer.
    const duplicate = await client.query(
      `SELECT reference
       FROM transactions
       WHERE account_id = $1
         AND idempotency_key = $2`,
      [sender.id, requestKey]
    );

    if (duplicate.rowCount > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        error: 'This transfer request has already been processed.',
        reference: duplicate.rows[0].reference
      });
    }

    const senderBalance = BigInt(sender.balance_minor);

    if (senderBalance < amountMinor) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Insufficient available balance.'
      });
    }

    // Generate distinct transaction references.
    const referenceBase = () =>
      'FB' + crypto.randomUUID()
        .replace(/-/g, '')
        .slice(0, 28)
        .toUpperCase();

    const debitReference = referenceBase() + 'D';
    const creditReference = referenceBase() + 'C';

    const formattedAmount = (
      Number(amountMinor) / 100
    ).toFixed(2);

    const debitDescription =
      `Demo transfer to ${recipient.account_number.trim()}`;

    const creditDescription =
      `Demo transfer from ${sender.account_number.trim()}`;

    // Debit the sender only if sufficient funds remain.
    const debitResult = await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor - $1::bigint,
           updated_at = NOW()
       WHERE id = $2
         AND balance_minor >= $1::bigint
       RETURNING balance_minor`,
      [amountMinor.toString(), sender.id]
    );

    if (debitResult.rowCount !== 1) {
      throw new Error('Sender balance changed; transfer cancelled.');
    }

    // Credit the recipient.
    await client.query(
      `UPDATE accounts
       SET balance_minor = balance_minor + $1::bigint,
           updated_at = NOW()
       WHERE id = $2`,
      [amountMinor.toString(), recipient.id]
    );

    // Record the sender's debit.
    await client.query(
      `INSERT INTO transactions
         (reference, account_id, type, amount_minor, currency,
          status, description, idempotency_key, posted_at)
       VALUES
         ($1, $2, 'transfer_debit', $3, $4,
          'completed', $5, $6, NOW())`,
      [
        debitReference,
        sender.id,
        amountMinor.toString(),
        sender.currency,
        debitDescription,
        requestKey
      ]
    );

    // Record the recipient's credit.
    await client.query(
      `INSERT INTO transactions
         (reference, account_id, type, amount_minor, currency,
          status, description, posted_at)
       VALUES
         ($1, $2, 'transfer_credit', $3, $4,
          'completed', $5, NOW())`,
      [
        creditReference,
        recipient.id,
        amountMinor.toString(),
        recipient.currency,
        creditDescription
      ]
    );

    // Record the action in the existing audit table.
    await client.query(
      `INSERT INTO audit_events
         (event_type, outcome, metadata)
       VALUES
         ('demo_transfer', 'success', $1::jsonb)`,
      [
        JSON.stringify({
          senderAccount: sender.account_number.trim(),
          recipientAccount: recipient.account_number.trim(),
          amountMinor: amountMinor.toString(),
          reference: debitReference
        })
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Demo transfer completed successfully.',
      reference: debitReference,
      recipient: {
        accountNumber: recipient.account_number.trim(),
        accountName: [
          recipient.first_name,
          recipient.middle_name,
          recipient.last_name
        ].filter(Boolean).join(' ')
      },
      amountMinor: amountMinor.toString(),
      currency: sender.currency.trim(),
      remainingBalanceMinor: String(debitResult.rows[0].balance_minor)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'This transfer request may already have been processed. Check your transaction history before retrying.'
      });
    }

    console.error('Demo transfer error:', error.message);

    res.status(500).json({
      error: 'The transfer could not be completed.'
    });
  } finally {
    client.release();
  }
});


// ============================================================
// BENEFICIARIES: LIST
// ============================================================

app.get('/api/beneficiaries', activeAccount, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         recipient_name,
         recipient_account_number,
         bank_name,
         created_at
       FROM beneficiaries
       WHERE owner_user_id = $1
       ORDER BY created_at DESC`,
      [req.session.userId]
    );

    res.json({
      beneficiaries: result.rows.map(item => ({
        id: item.id,
        recipientName: item.recipient_name,
        accountNumber: item.recipient_account_number.trim(),
        bankName: item.bank_name,
        createdAt: item.created_at
      }))
    });
  } catch (error) {
    console.error('Beneficiary list error:', error.message);

    res.status(500).json({
      error: 'Could not load beneficiaries.'
    });
  }
});


// ============================================================
// BENEFICIARIES: ADD
// ============================================================

app.post('/api/beneficiaries', activeAccount, async (req, res) => {
  try {
    const accountNumber = String(
      req.body?.accountNumber || ''
    ).trim();

    const bankName = String(
      req.body?.bankName || 'Fubs Online Banking'
    ).trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        error: 'Enter a valid 10-digit account number.'
      });
    }

    if (bankName !== 'Fubs Online Banking') {
      return res.status(400).json({
        error: 'Only Fubs internal demo accounts are supported.'
      });
    }

    const recipientResult = await pool.query(
      `SELECT
         a.account_number,
         u.first_name,
         u.middle_name,
         u.last_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE a.account_number = $1
         AND a.status = 'active'
         AND u.account_status = 'active'`,
      [accountNumber]
    );

    if (recipientResult.rowCount === 0) {
      return res.status(404).json({
        error: 'No eligible Fubs account was found.'
      });
    }

    const recipient = recipientResult.rows[0];

    const recipientName = [
      recipient.first_name,
      recipient.middle_name,
      recipient.last_name
    ].filter(Boolean).join(' ');

    const inserted = await pool.query(
      `INSERT INTO beneficiaries
         (owner_user_id, recipient_name,
          recipient_account_number, bank_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, recipient_name,
                 recipient_account_number, bank_name, created_at`,
      [
        req.session.userId,
        recipientName,
        recipient.account_number.trim(),
        bankName
      ]
    );

    const item = inserted.rows[0];

    res.status(201).json({
      message: 'Beneficiary saved.',
      beneficiary: {
        id: item.id,
        recipientName: item.recipient_name,
        accountNumber: item.recipient_account_number.trim(),
        bankName: item.bank_name,
        createdAt: item.created_at
      }
    });
  } catch (error) {
    console.error('Add beneficiary error:', error.message);

    res.status(500).json({
      error: 'Could not save beneficiary.'
    });
  }
});


// ============================================================
// BENEFICIARIES: DELETE
// ============================================================

app.delete(
  '/api/beneficiaries/:id',
  activeAccount,
  async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM beneficiaries
         WHERE id = $1
           AND owner_user_id = $2
         RETURNING id`,
        [req.params.id, req.session.userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: 'Beneficiary not found.'
        });
      }

      res.json({
        message: 'Beneficiary removed.'
      });
    } catch (error) {
      console.error('Delete beneficiary error:', error.message);

      res.status(500).json({
        error: 'Could not remove beneficiary.'
      });
    }
  }
);

app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));
app.use((err,_req,res,_next)=>{console.error('Application error:',err.message);res.status(500).json({error:'Unexpected server error.'});});
(async()=>{try{await pool.query('SELECT 1');app.listen(PORT,'0.0.0.0',()=>console.log(`Fubs Online Banking foundation listening on ${PORT}`));}catch(e){console.error('PostgreSQL connection failed:',e.message);process.exit(1);}})();
process.on('SIGTERM',async()=>{await pool.end().catch(()=>{});process.exit(0);});
async function activeAccount(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: 'Please sign in to continue.'
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         u.account_status AS user_status,
         a.status AS bank_account_status
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.id = $1`,
      [req.session.userId]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: 'Account not found. Please sign in again.'
      });
    }

    const account = result.rows[0];

    if (
      account.user_status !== 'active' ||
      account.bank_account_status !== 'active'
    ) {
      return res.status(403).json({
        error: 'Banking features are unavailable until your account is approved and active.',
        accountStatus: account.user_status
      });
    }

    next();
  } catch (error) {
    console.error('Account-status check failed:', error.message);

    return res.status(500).json({
      error: 'Could not verify account status. Please try again.'
    });
  }
}
function adminAuth(req, res, next) {
  const configuredEmail = String(process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  if (
    !configuredEmail ||
    req.session.isAdmin !== true ||
    req.session.adminEmail !== configuredEmail
  ) {
    return res.status(401).json({
      error: 'Administrator sign-in required.'
    });
  }

  next();
}
