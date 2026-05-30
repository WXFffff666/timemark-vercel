import axios from 'axios';
import { getBlessing } from '../../../../shared/src/blessings.js';

/**
 * BlueBubbles iMessage Service
 * 
 * BlueBubbles is a macOS server that provides REST API for iMessage.
 * It requires a running BlueBubbles server on macOS.
 * 
 * API Documentation: https://bluebubbles.app/api
 */

interface BlueBubblesConfig {
  serverUrl: string;
  password: string;
}

interface BlueBubblesSessionData {
  serverUrl: string;
  password: string;
  sessionId: string;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `bluebubbles_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create axios instance with BlueBubbles auth
 */
function createBlueBubblesClient(serverUrl: string, password: string) {
  const baseURL = serverUrl.replace(/\/$/, '');
  return axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${password}`
    }
  });
}

/**
 * Start authentication with BlueBubbles server
 * Returns connection instructions and session ID
 */
export async function startAuth(config: BlueBubblesConfig): Promise<{ qrcode: string; sessionId: string }> {
  const sessionId = generateSessionId();
  
  const serverUrl = config.serverUrl || 'http://localhost:5000';
  const password = config.password;
  
  if (!password) {
    throw new Error('BlueBubbles password is required');
  }
  
  // Test connection to BlueBubbles server
  try {
    const client = createBlueBubblesClient(serverUrl, password);
    
    // Get server info to verify connection
    const response = await client.get('/api/version');
    
    return {
      qrcode: JSON.stringify({
        status: 'connected',
        serverVersion: response.data?.version || 'unknown',
        serverUrl: serverUrl,
        message: 'BlueBubbles server connected successfully'
      }),
      sessionId
    };
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.message;
    
    // Provide specific instructions based on error
    if (error.code === 'ECONNREFUSED') {
      return {
        qrcode: JSON.stringify({
          status: 'connection_failed',
          error: 'Cannot connect to BlueBubbles server',
          serverUrl: serverUrl,
          message: 'Please ensure BlueBubbles server is running on macOS. Default URL: http://localhost:5000'
        }),
        sessionId
      };
    }
    
    if (error.response?.status === 401) {
      return {
        qrcode: JSON.stringify({
          status: 'auth_failed',
          error: 'Invalid password',
          serverUrl: serverUrl,
          message: 'Please check your BlueBubbles password and try again'
        }),
        sessionId
      };
    }
    
    throw new Error(`Failed to connect to BlueBubbles server: ${errorMessage}`);
  }
}

/**
 * Check if authenticated with BlueBubbles server
 */
export async function checkAuth(sessionData: BlueBubblesSessionData): Promise<{ authenticated: boolean }> {
  if (!sessionData || !sessionData.serverUrl || !sessionData.password) {
    return { authenticated: false };
  }
  
  try {
    const client = createBlueBubblesClient(sessionData.serverUrl, sessionData.password);
    
    // Test API connection
    await client.get('/api/version');
    
    return { authenticated: true };
  } catch (error) {
    console.error('BlueBubbles checkAuth error:', error);
    return { authenticated: false };
  }
}

/**
 * Logout from BlueBubbles server
 * Note: BlueBubbles doesn't have explicit logout, just clear session
 */
export async function logout(sessionData: BlueBubblesSessionData): Promise<void> {
  if (!sessionData) {
    return;
  }
  
  // BlueBubbles server doesn't have a logout endpoint
  // Just clear the session locally
  console.log('BlueBubbles session cleared:', sessionData.sessionId);
}

/**
 * Send iMessage notification via BlueBubbles
 */
export async function sendNotification(
  event: any,
  sessionData: BlueBubblesSessionData,
  toUser: string
): Promise<void> {
  if (!sessionData || !sessionData.serverUrl || !sessionData.password) {
    throw new Error('Invalid session data');
  }
  
  if (!toUser) {
    throw new Error('Recipient phone number or email is required');
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
    message = `📅 ${event.name}\n\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;
  }
  
  const client = createBlueBubblesClient(sessionData.serverUrl, sessionData.password);
  
  try {
    // Send message via BlueBubbles API
    // BlueBubbles expects: { "text": "...", " recipients": ["+1234567890"] }
    const response = await client.post('/api/messages/send', {
      text: message,
      recipients: [toUser]
    });
    
    if (response.data?.error) {
      throw new Error(response.data.error);
    }
    
    console.log('BlueBubbles message sent successfully:', response.data);
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error('BlueBubbles sendNotification error:', errorMessage);
    throw new Error(`Failed to send iMessage: ${errorMessage}`);
  }
}

/**
 * Get chats from BlueBubbles server
 */
export async function getChats(sessionData: BlueBubblesSessionData): Promise<any[]> {
  if (!sessionData || !sessionData.serverUrl || !sessionData.password) {
    throw new Error('Invalid session data');
  }
  
  const client = createBlueBubblesClient(sessionData.serverUrl, sessionData.password);
  
  try {
    const response = await client.get('/api/chats');
    return response.data || [];
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.message;
    throw new Error(`Failed to get chats: ${errorMessage}`);
  }
}

/**
 * Get contacts from BlueBubbles server
 */
export async function getContacts(sessionData: BlueBubblesSessionData): Promise<any[]> {
  if (!sessionData || !sessionData.serverUrl || !sessionData.password) {
    throw new Error('Invalid session data');
  }
  
  const client = createBlueBubblesClient(sessionData.serverUrl, sessionData.password);
  
  try {
    const response = await client.get('/api/contacts');
    return response.data || [];
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.message;
    throw new Error(`Failed to get contacts: ${errorMessage}`);
  }
}

/**
 * Export for use in notifications index
 */
export const sendBlueBubblesNotification = sendNotification;
