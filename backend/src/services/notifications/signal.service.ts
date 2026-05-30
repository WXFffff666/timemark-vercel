import { getBlessing } from '../../../../shared/src/blessings.js';
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

/**
 * Signal Service - Using signal-cli command-line tool
 * 
 * Signal uses phone number as identifier (e.g., +86138xxxxxxxx)
 * signal-cli needs to be installed on the system
 */

interface SignalSessionData {
  phoneNumber: string;
  sessionId: string;
  dataPath?: string;
}

function generateSessionId(): string {
  return `signal_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getSignalDataDir(phoneNumber: string, sessionId: string): string {
  return path.join(tmpdir(), 'timemark', 'signal', phoneNumber, sessionId);
}

function ensureSignalDataDir(phoneNumber: string, sessionId: string): string {
  const dataDir = getSignalDataDir(phoneNumber, sessionId);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function cleanupSignalData(phoneNumber: string, sessionId: string): void {
  const dataDir = getSignalDataDir(phoneNumber, sessionId);
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Execute signal-cli command
 */
function executeSignalCli(args: string[], dataDir?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = 'signal-cli';
    
    const options: any = {
      shell: true,
    };
    
    if (dataDir) {
      options.env = { ...process.env, SIGNAL_CLI_DATA: dataDir };
    }
    
    const proc = spawn(command, args, options);
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`signal-cli exited with code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
    
    // Timeout after 60 seconds
    setTimeout(() => {
      proc.kill();
      reject(new Error('signal-cli command timeout'));
    }, 60000);
  });
}

/**
 * Start account registration/link process
 * Returns instructions for user to complete linking
 */
export async function startAuth(phoneNumber: string): Promise<{ qrcode: string; sessionId: string }> {
  const sessionId = generateSessionId();
  const dataDir = ensureSignalDataDir(phoneNumber, sessionId);
  
  try {
    // Use link mode to generate a QR code for linking
    // signal-cli link generates a link that can be scanned with Signal app
    const output = await executeSignalCli(['link', '--json'], dataDir);
    
    // Parse the JSON output to get the link device info
    let linkInfo;
    try {
      linkInfo = JSON.parse(output.trim());
    } catch {
      // If not JSON, return instructions as qrcode placeholder
      return {
        qrcode: output || 'signal-cli link',
        sessionId
      };
    }
    
    return {
      qrcode: JSON.stringify(linkInfo),
      sessionId
    };
    
  } catch (error) {
    cleanupSignalData(phoneNumber, sessionId);
    throw error;
  }
}

/**
 * Check if authenticated/linked
 * For signal-cli, we check if the data directory has valid session files
 */
export async function checkAuth(sessionData: SignalSessionData): Promise<{ authenticated: boolean }> {
  if (!sessionData || !sessionData.phoneNumber || !sessionData.sessionId) {
    return { authenticated: false };
  }
  
  try {
    const dataDir = getSignalDataDir(sessionData.phoneNumber, sessionData.sessionId);
    
    // Check if data directory exists and has files
    if (!fs.existsSync(dataDir)) {
      return { authenticated: false };
    }
    
    const files = fs.readdirSync(dataDir);
    
    // Check for config.json which indicates a linked account
    const hasConfig = files.some(f => f.includes('config') || f.includes('accounts'));
    
    if (!hasConfig) {
      return { authenticated: false };
    }
    
    // Try to verify by getting account info
    try {
      await executeSignalCli(['-u', sessionData.phoneNumber, 'info'], dataDir);
      return { authenticated: true };
    } catch {
      // If info fails, account might not be properly linked
      return { authenticated: false };
    }
    
  } catch (error) {
    console.error('Signal checkAuth error:', error);
    return { authenticated: false };
  }
}

/**
 * Logout and unlink account
 */
export async function logout(sessionData: SignalSessionData): Promise<void> {
  if (!sessionData || !sessionData.phoneNumber || !sessionData.sessionId) {
    return;
  }
  
  try {
    const dataDir = getSignalDataDir(sessionData.phoneNumber, sessionData.sessionId);
    
    // Try to logout using signal-cli
    try {
      await executeSignalCli(['-u', sessionData.phoneNumber, 'logout'], dataDir);
    } catch {
      // Even if logout fails, cleanup local data
    }
    
    // Cleanup local session data
    cleanupSignalData(sessionData.phoneNumber, sessionData.sessionId);
    
  } catch (error) {
    console.error('Signal logout error:', error);
    // Still cleanup local data even if remote logout fails
    cleanupSignalData(sessionData.phoneNumber, sessionData.sessionId);
    throw error;
  }
}

/**
 * Serialize session data for storage
 */
export function serializeSession(sessionData: SignalSessionData): SignalSessionData {
  return {
    phoneNumber: sessionData.phoneNumber,
    sessionId: sessionData.sessionId,
    dataPath: getSignalDataDir(sessionData.phoneNumber, sessionData.sessionId)
  };
}

/**
 * Send Signal notification message
 */
export async function sendNotification(
  event: any,
  sessionData: SignalSessionData,
  toUser: string
): Promise<void> {
  if (!sessionData || !sessionData.phoneNumber || !sessionData.sessionId) {
    throw new Error('Invalid session data');
  }
  
  // Validate phone number format
  if (!toUser || !toUser.match(/^\+\d{10,15}$/)) {
    throw new Error('Invalid recipient phone number. Must be in format +1xxxxxxxxxx');
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
  
  const dataDir = getSignalDataDir(sessionData.phoneNumber, sessionData.sessionId);
  
  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    throw new Error('Session data not found. Please re-authenticate.');
  }
  
  try {
    // Send message using signal-cli
    await executeSignalCli(
      ['-u', sessionData.phoneNumber, 'send', '-m', message, toUser],
      dataDir
    );
  } catch (error) {
    console.error('Signal sendNotification error:', error);
    throw error;
  }
}

/**
 * Export for use in notifications index
 */
export const sendSignalNotification = sendNotification;