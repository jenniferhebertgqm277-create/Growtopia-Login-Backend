import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { SQL } from 'bun';

const app = express();
const PORT = 3000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 30 * 60 * 1000;

// @note JoTavern: kredensial MySQL dipisah dari nama database, karena tiap
// tenant punya nama database sendiri (gurotopia_<tenant>) di server MySQL yang sama.
// Sebelumnya: satu DATABASE_URL tetap buat semua orang (tidak multi-tenant).
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = process.env.DB_PORT || '3306';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const CONTROL_DB_NAME = process.env.CONTROL_DB_NAME || 'jotavern_control';

function buildDbUrl(dbName: string): string {
  const auth = DB_PASS ? `${DB_USER}:${DB_PASS}` : DB_USER;
  return `mysql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

// @note koneksi ke database kontrol (tempat tabel `tenants` hidup)
const controlDb = new SQL(buildDbUrl(CONTROL_DB_NAME));

// @note JoTavern: cache koneksi per-tenant biar gak bikin koneksi baru tiap request
const tenantDbCache = new Map<string, SQL>();

interface TenantInfo {
  name: string;
  ip: string;
  port: number;
  db_name: string;
}

// @note JoTavern: lookup tenant dari tabel `tenants` (kolom db_name WAJIB ditambah,
// lihat catatan skema di README patch). Return null kalau nama tenant gak ketemu.
async function lookupTenant(serverName: string): Promise<TenantInfo | null> {
  if (!serverName) return null;
  const rows = await controlDb`SELECT name, ip, port, db_name FROM tenants WHERE name = ${serverName} LIMIT 1`;
  if (rows.length === 0) return null;
  return rows[0] as TenantInfo;
}

// @note JoTavern: ambil (atau bikin & cache) koneksi SQL ke database tenant tertentu
function getTenantDb(dbName: string): SQL {
  let conn = tenantDbCache.get(dbName);
  if (!conn) {
    conn = new SQL(buildDbUrl(dbName));
    tenantDbCache.set(dbName, conn);
  }
  return conn;
}

const ipAttempts = new Map<string, { count: number; blockedUntil: number }>();

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const xri = req.headers['x-real-ip'];
  const forwarded = Array.isArray(xff) ? xff[0] : xff;
  const realIp = Array.isArray(xri) ? xri[0] : xri;
  return (
    (forwarded as string)?.split(',')[0]?.trim() ||
    (realIp as string) ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function checkIpBlocked(clientIp: string): { blocked: boolean; remaining: number } {
  const record = ipAttempts.get(clientIp);
  if (!record) return { blocked: false, remaining: MAX_ATTEMPTS };
  const now = Date.now();
  if (record.blockedUntil > now) {
    return { blocked: true, remaining: 0 };
  }
  if (record.blockedUntil > 0 && record.blockedUntil <= now) {
    ipAttempts.delete(clientIp);
    return { blocked: false, remaining: MAX_ATTEMPTS };
  }
  return { blocked: false, remaining: MAX_ATTEMPTS - record.count };
}

function recordFailedAttempt(clientIp: string): number {
  const record = ipAttempts.get(clientIp) || { count: 0, blockedUntil: 0 };
  const now = Date.now();
  if (record.blockedUntil > now) {
    return 0;
  }
  record.count += 1;
  const remaining = MAX_ATTEMPTS - record.count;
  if (record.count >= MAX_ATTEMPTS) {
    record.blockedUntil = now + COOLDOWN_MS;
    console.log(`[BLOCKED] IP ${clientIp} blocked for 30 minutes`);
  }
  ipAttempts.set(clientIp, record);
  return Math.max(0, remaining);
}

function resetAttempts(clientIp: string): void {
  ipAttempts.delete(clientIp);
}

app.set('trust proxy', 1);

// @note middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// @note rate limiter - 50 requests per minute
const limiter = rateLimit({
  windowMs: 60_000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false },
});
app.use(limiter);

// @note static files from public folder
app.use(express.static(path.join(process.cwd(), 'public')));

app.use((req: Request, _res: Response, next: NextFunction) => {
  const clientIp = getClientIp(req);
  console.log(
    `[REQ] ${req.method} ${req.path} → ${clientIp} | ${_res.statusCode}`,
  );
  next();
});

// @note root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.send('Hello, world!');
});

/**
 * @note dashboard endpoint - serves login HTML page with client data
 * @note JoTavern v0.2.3: Server Name sekarang input teks bebas (bukan dropdown
 * lagi), jadi gak perlu suntik daftar tenant ke placeholder manapun di sini.
 */
app.all('/player/login/dashboard', async (req: Request, res: Response) => {
  const body = req.body;
  let clientData = '';

  if (body && typeof body === 'object' && Object.keys(body).length > 0) {
    clientData = Object.keys(body)[0];
  }

  const encodedClientData = Buffer.from(clientData).toString('base64');

  const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
  const templateContent = fs.readFileSync(templatePath, 'utf-8');
  const htmlContent = templateContent.replace('{{ data }}', encodedClientData);

  res.setHeader('Content-Type', 'text/html');
  res.send(htmlContent);
});

/**
 * @note validate login endpoint - validates GrowID credentials from MySQL
 * @note JoTavern: sekarang butuh field `server` (nama tenant) dari form,
 * dipakai buat lookup database tenant yang benar sebelum query tabel peer,
 * dan diikutkan ke dalam token supaya gateway (C++) bisa redirect ke tenant itu.
 */
app.all(
  '/player/growid/login/validate',
  async (req: Request, res: Response) => {
    const clientIp = getClientIp(req);
    const { blocked, remaining } = checkIpBlocked(clientIp);

    // @note JoTavern v0.2.3: Server Name udah input teks bebas, jadi renderError
    // gak perlu lagi query/isi ulang daftar tenant (dulu buat dropdown)
    const renderError = (errorMessage: string, clientDataRaw: string = '') => {
      const templatePath = path.join(process.cwd(), 'template', 'dashboard.html');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      const errorHtml = `<div class="text-danger text-danger-wrapper"><ul><li>${errorMessage}</li></ul></div>`;
      let htmlContent = templateContent.replace('{{ data }}', Buffer.from(clientDataRaw).toString('base64'));
      htmlContent = htmlContent.replace('<div class="row div-content-center">', `${errorHtml}<div class="row div-content-center">`);
      res.setHeader('Content-Type', 'text/html');
      res.send(htmlContent);
    };

    if (blocked) {
      renderError('Login attempts exhausted from your IP, Please try again later after 30 mins');
      return;
    }

    try {
      const formData = req.body as Record<string, string>;
      const email = formData.email;
      if (email) {
        return;
      }

      const _token = formData._token;
      const growId = formData.growId;
      const password = formData.password;
      const serverName = formData.server; // @note JoTavern v0.2.3: field dari input teks bebas Server Name (bukan dropdown lagi)

      if (!growId || !password) {
        res.status(200).json({
          status: 'error',
          message: 'Missing growId or password',
        });
        return;
      }

      if (!serverName) {
        res.status(200).json({
          status: 'error',
          message: 'Missing server selection',
        });
        return;
      }

      // @note JoTavern: lookup tenant tujuan dulu sebelum sentuh database manapun
      const tenant = await lookupTenant(serverName);
      if (!tenant) {
        renderError('Server yang dipilih tidak ditemukan.', btoa(`${growId}`));
        return;
      }

      const tenantDb = getTenantDb(tenant.db_name);
      const rows = await tenantDb`SELECT * FROM peer WHERE growid = ${growId} LIMIT 1`;

      if (rows.length === 0) {
        const attemptsLeft = recordFailedAttempt(clientIp);
        renderError(
          `Account credentials missmatched. You have ${attemptsLeft} attempt(s) left.`,
          btoa(`${growId}`),
        );
        return;
      }

      const user = rows[0];
      if (user.password !== password) {
        const attemptsLeft = recordFailedAttempt(clientIp);
        renderError(
          `Account credentials missmatched. You have ${attemptsLeft} attempt(s) left.`,
          btoa(`${growId}`),
        );
        return;
      }

      resetAttempts(clientIp);

      // @note JoTavern: field &server= diikutkan, ini yang dibaca gateway (C++ protocol.cpp)
      // buat mutusin mau redirect kemana
      const token = Buffer.from(
        `_token=${_token}&growId=${growId}&password=${password}&server=${serverName}&reg=0`,
      ).toString('base64');

      res.send(
        JSON.stringify({
          status: 'success',
          message: 'Account Validated.',
          token,
          url: '',
          accountType: 'growtopia',
        }),
      );
    } catch (error) {
      console.log(`[ERROR]: ${error}`);
      res.status(500).json({
        status: 'error',
        message: 'Internal Server Error',
      });
    }
  },
);

/**
 * @note first checktoken endpoint - redirects to validate endpoint
 */
app.all('/player/growid/checktoken', async (_req: Request, res: Response) => {
  return res.redirect(307, '/player/growid/validate/checktoken');
});

/**
 * @note second checktoken endpoint - validates token and returns updated token
 * @note JoTavern: field &server= sudah ada di dalam decodedRefreshToken (ikut ke-preserve
 * karena cuma &reg= yang dihapus/diganti di sini), jadi tidak perlu diubah.
 */
app.all(
  '/player/growid/validate/checktoken',
  async (req: Request, res: Response) => {
    try {
      let refreshToken: string | undefined;
      let clientData: string | undefined;
      let source = 'empty';

      const contentType = req.headers['content-type'] || '';

      if (typeof req.body === 'object' && req.body !== null) {
        const formData = req.body as Record<string, string>;
        if ('refreshToken' in formData || 'clientData' in formData) {
          refreshToken = formData.refreshToken;
          clientData = formData.clientData;
          source = contentType.includes('application/json')
            ? 'json/object'
            : 'form-urlencoded';
        } else if (Object.keys(formData).length === 1) {
          const rawPayload = Object.keys(formData)[0];
          const params = new URLSearchParams(rawPayload);
          refreshToken = params.get('refreshToken') || undefined;
          clientData = params.get('clientData') || undefined;
          if (refreshToken || clientData) {
            source = 'single-key-form-payload';
          }
        }
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        const params = new URLSearchParams(req.body);
        refreshToken = params.get('refreshToken') || undefined;
        clientData = params.get('clientData') || undefined;
        source = 'string/body-parser';
      }

      if (
        (!refreshToken || !clientData) &&
        req.readable &&
        !req.readableEnded
      ) {
        const rawBody = await new Promise<string>((resolve, reject) => {
          let rawPayload = '';
          req.on('data', (chunk: Buffer | string) => {
            rawPayload += chunk.toString();
          });
          req.on('end', () => resolve(rawPayload));
          req.on('error', reject);
        });

        if (rawBody) {
          const params = new URLSearchParams(rawBody);
          refreshToken = params.get('refreshToken') || refreshToken;
          clientData = params.get('clientData') || clientData;
          if (refreshToken || clientData) {
            source = 'raw-stream';
          }
        }
      }

      console.log(`[CHECKTOKEN] Parsed as ${source}`);

      if (!refreshToken || !clientData) {
        console.log(`[ERROR]: Missing refreshToken or clientData`);
        res.status(200).json({
          status: 'error',
          message: 'Missing refreshToken or clientData',
        });
        return;
      }

      let decodedRefreshToken = Buffer.from(refreshToken, 'base64').toString(
        'utf-8',
      );

      if (decodedRefreshToken.includes('&reg=0')) {
        decodedRefreshToken = decodedRefreshToken.replace('&reg=0', '');
      } else if (decodedRefreshToken.includes('&reg=1')) {
        decodedRefreshToken = decodedRefreshToken.replace('&reg=1', '');
      }

      const token = Buffer.from(
        decodedRefreshToken.replace(
          /(_token=)[^&]*/,
          `$1${Buffer.from(clientData).toString('base64')}`,
        ),
      ).toString('base64');

      res.send(
        JSON.stringify({
          status: 'success',
          message: 'Account Validated.',
          token,
          url: '',
          accountType: 'growtopia',
          accountAge: 2,
        }),
      );
    } catch (error) {
      console.log(`[ERROR]: ${error}`);
      res.status(200).json({
        status: 'error',
        message: 'Internal Server Error',
      });
    }
  },
);

/**
 * @note JoTavern v0.2.3: halaman /host - referensi IP gateway TERKINI buat
 * di-set di PowerTunnel (hosts). Berguna karena VPS-nya ganti-ganti (sewa
 * harian) - tinggal update env var GATEWAY_IP di Vercel, halaman ini auto
 * ikut update tanpa perlu redeploy kode.
 */
app.get('/host', (_req: Request, res: Response) => {
  const gatewayIp = process.env.GATEWAY_IP || '(belum di-set, isi env var GATEWAY_IP di Vercel)';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>JoTavern - Host Info</title></head>
<body style="font-family: monospace; padding: 2rem;">
  <h2>JoTavern Gateway - IP Terkini</h2>
  <p>IP: <strong>${gatewayIp}</strong></p>
  <p>Isi ini di plugin Hosts PowerTunnel:</p>
  <pre>${gatewayIp} www.growtopia1.com
${gatewayIp} www.growtopia2.com
${gatewayIp} growtopia1.com
${gatewayIp} growtopia2.com</pre>
</body>
</html>`);
});

/**
 * @note JoTavern v0.2.3: /hosts.txt - PLAIN TEXT MURNI (bukan HTML), khusus
 * buat dipasang sebagai URL host file di PowerTunnel (plugin Hosts). Format
 * "IP domain" standar, gak ada tag HTML sama sekali - beda dari /host yang
 * HTML buat dibaca manusia.
 */
app.get('/hosts.txt', (_req: Request, res: Response) => {
  const gatewayIp = process.env.GATEWAY_IP || '';
  res.setHeader('Content-Type', 'text/plain');
  if (!gatewayIp) {
    res.send('# GATEWAY_IP belum di-set di environment variables Vercel');
    return;
  }
  res.send(`${gatewayIp} www.growtopia1.com
${gatewayIp} www.growtopia2.com
${gatewayIp} growtopia1.com
${gatewayIp} growtopia2.com
`);
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
});

export default app;
