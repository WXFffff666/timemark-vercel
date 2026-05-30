import { getBlessing } from '../../../../shared/src/blessings.js';
import QRCode from 'qrcode';
import * as Baileys from 'baileys';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

const makeWASocket = (Baileys as any).makeWASocket || (Baileys as any).default?.makeWASocket;
const useMultiFileAuthState = (Baileys as any).useMultiFileAuthState;
const DisconnectReason = (Baileys as any).DisconnectReason;

// Active socket instances (in-memory only)
const activeSockets = new Map<string, any>();

interface WhatsAppSession {
  sessionId: string;
  authState: any;
  user?: string;
}

function generateSessionId(): string {
  return `whatsapp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function createTempAuthState(sessionId: string) {
  const tempDir = path.join(tmpdir(), 'timemark', 'whatsapp', sessionId);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return useMultiFileAuthState(tempDir);
}

function cleanupTempDir(sessionId: string) {
  const tempDir = path.join(tmpdir(), 'timemark', 'whatsapp', sessionId);
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Start QR code authentication flow
 * Returns QR code data URL and session ID
 */
export async function startAuth(): Promise<{ qrcode: string; sessionId: string }> {
  return new Promise(async (resolve, reject) => {
    const sessionId = generateSessionId();
    
    try {
      const { state, saveCreds } = await createTempAuthState(sessionId);
      
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['TimeMark', 'Desktop', '1.0.0'],
      });

      let qrResolved = false;

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !qrResolved) {
          // Generate QR code data URL
          const qrcode = await QRCode.toDataURL(qr, {
            width: 400,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#ffffff',
            },
          });
          qrResolved = true;
          
          // Store socket temporarily
          activeSockets.set(sessionId, sock);
          
          resolve({ qrcode, sessionId });
        }

        if (connection === 'open') {
          // Authentication successful
          await saveCreds();
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          
          if (!shouldReconnect) {
            // Logged out, cleanup
            activeSockets.delete(sessionId);
            cleanupTempDir(sessionId);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Timeout after 2 minutes
      setTimeout(() => {
        if (!qrResolved) {
          sock.end(undefined);
          activeSockets.delete(sessionId);
          cleanupTempDir(sessionId);
          reject(new Error('QR code generation timeout'));
        }
      }, 120000);

    } catch (error) {
      cleanupTempDir(sessionId);
      reject(error);
    }
  });
}

/**
 * Check if authenticated with the given session data
 */
export async function checkAuth(sessionData: any): Promise<{ authenticated: boolean; user?: string }> {
  if (!sessionData || !sessionData.authState) {
    return { authenticated: false };
  }

  try {
    // Create temporary directory and restore auth state
    const sessionId = sessionData.sessionId || generateSessionId();
    const tempDir = path.join(tmpdir(), 'timemark', 'whatsapp', sessionId);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Restore auth state to temp files
    if (sessionData.authState) {
      for (const [key, value] of Object.entries(sessionData.authState)) {
        fs.writeFileSync(
          path.join(tempDir, key),
          JSON.stringify(value, BufferJSON.replacer)
        );
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    
    return new Promise((resolve) => {
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['TimeMark', 'Desktop', '1.0.0'],
      });

      let authenticated = false;
      let userId: string | undefined;

      sock.ev.on('connection.update', async (update: any) => {
        const { connection } = update;

        // Check if we have user info from auth state
        if (state.creds?.me?.id) {
          userId = state.creds.me.id.split(':')[0];
        }

        if (connection === 'open') {
          authenticated = true;
          await saveCreds();
          sock.end(undefined);
          cleanupTempDir(sessionId);
          resolve({ 
            authenticated: true, 
            user: userId || 'unknown'
          });
        }

        if (connection === 'close') {
          sock.end(undefined);
          cleanupTempDir(sessionId);
          resolve({ authenticated });
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        sock.end(undefined);
        cleanupTempDir(sessionId);
        resolve({ authenticated: false });
      }, 10000);
    });

  } catch (error) {
    console.error('WhatsApp check auth error:', error);
    return { authenticated: false };
  }
}

/**
 * Logout and clear session
 */
export async function logout(sessionData: any): Promise<void> {
  if (!sessionData) return;

  try {
    // End any active socket
    if (sessionData.sessionId && activeSockets.has(sessionData.sessionId)) {
      const sock = activeSockets.get(sessionData.sessionId);
      if (sock) {
        sock.logout();
        sock.end(undefined);
      }
      activeSockets.delete(sessionData.sessionId);
    }

    // Cleanup temp directory
    if (sessionData.sessionId) {
      cleanupTempDir(sessionData.sessionId);
    }
  } catch (error) {
    console.error('WhatsApp logout error:', error);
    throw error;
  }
}

/**
 * Serialize auth state for storage
 */
export async function serializeAuthState(sessionId: string): Promise<WhatsAppSession | null> {
  const tempDir = path.join(tmpdir(), 'timemark', 'whatsapp', sessionId);
  
  if (!fs.existsSync(tempDir)) {
    return null;
  }

  const authState: Record<string, any> = {};
  const files = fs.readdirSync(tempDir);
  
  for (const file of files) {
    const filePath = path.join(tempDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    authState[file] = JSON.parse(content, BufferJSON.reviver);
  }

  return {
    sessionId,
    authState,
  };
}

/**
 * Send WhatsApp notification message
 */
export async function sendNotification(
  event: any,
  sessionData: any,
  toUser: string
): Promise<void> {
  if (!sessionData || !sessionData.authState) {
    throw new Error('Invalid session data');
  }

  let message: string;
  if (event.customMessage) {
    message = event.customMessage;
  } else {
    const blessing = getBlessing(
      event.type,
      event.reminderConfig?.customMessage,
      event.personName,
      event.reminderRecipientName
    );
    message = `📅 *${event.name}*\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }

  // Create temp auth state
  const sessionId = sessionData.sessionId || generateSessionId();
  const tempDir = path.join(tmpdir(), 'timemark', 'whatsapp', sessionId);
  
  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Restore auth state to temp files
    if (sessionData.authState) {
      for (const [key, value] of Object.entries(sessionData.authState)) {
        fs.writeFileSync(
          path.join(tempDir, key),
          JSON.stringify(value, BufferJSON.replacer)
        );
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    
    return new Promise(async (resolve, reject) => {
      const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['TimeMark', 'Desktop', '1.0.0'],
      });

      sock.ev.on('connection.update', async (update: any) => {
        const { connection } = update;

        if (connection === 'open') {
          try {
            // Format phone number (remove any non-numeric characters)
            const phoneNumber = toUser.replace(/\D/g, '');
            const jid = `${phoneNumber}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: message });
            
            await saveCreds();
            sock.end(undefined);
            cleanupTempDir(sessionId);
            resolve();
          } catch (error) {
            sock.end(undefined);
            cleanupTempDir(sessionId);
            reject(error);
          }
        }

        if (connection === 'close') {
          cleanupTempDir(sessionId);
          reject(new Error('Connection closed'));
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // Timeout after 30 seconds
      setTimeout(() => {
        sock.end(undefined);
        cleanupTempDir(sessionId);
        reject(new Error('Send message timeout'));
      }, 30000);
    });

  } catch (error) {
    cleanupTempDir(sessionId);
    throw error;
  }
}

// Helper class for JSON serialization of Buffer objects
class BufferJSON {
  static replacer(key: string, value: any) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return {
        type: 'Buffer',
        data: Buffer.from(value).toString('base64'),
      };
    }
    return value;
  }

  static reviver(key: string, value: any) {
    if (value && value.type === 'Buffer' && value.data) {
      return Buffer.from(value.data, 'base64');
    }
    return value;
  }
}
