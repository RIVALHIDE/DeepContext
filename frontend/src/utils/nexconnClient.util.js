let initializedAppKey = '';
let callInstalled = false;
let customMessagesRegistered = false;

export const NEXCONN_TYPING_MESSAGE = 'DC:Typing';

export function nexconnResultError(result, fallback) {
  const code = result?.code;
  return result?.msg || (code != null ? `${fallback} (Nexconn code ${code})` : fallback);
}

/**
 * Initialize Nexconn once, in the order required by the Call SDK, then connect
 * the authenticated browser user with the short-lived token from our API.
 */
export async function connectNexconn(session, { includeCall = false } = {}) {
  const [chat, call] = await Promise.all([
    import('@nexconn/chat'),
    import('@nexconn/call'),
  ]);

  // Nexconn requires the Call plugin to be installed before Chat's NCEngine is
  // initialized. Install it even for chat-only screens so opening Chat first
  // cannot make Huddle fail later in the same browser tab.
  if (!callInstalled) {
    call.NCCallEngine.install();
    callInstalled = true;
  }

  if (initializedAppKey && initializedAppKey !== session.app_key) {
    throw new Error('The Nexconn App Key changed. Reload this browser tab to reconnect.');
  }
  if (!initializedAppKey) {
    const areas = {
      sg: chat.AreaCode.SG,
      bj: chat.AreaCode.BJ,
      na: chat.AreaCode.NA,
      sa: chat.AreaCode.SA,
      om: chat.AreaCode.OM,
    };
    chat.NCEngine.initialize({
      appKey: session.app_key,
      areaCode: areas[session.area_code] || chat.AreaCode.SG,
    });
    initializedAppKey = session.app_key;
  }

  if (!customMessagesRegistered) {
    chat.NCEngine.registerCustomMessages([{
      messageType: NEXCONN_TYPING_MESSAGE,
      isPersisted: false,
      isCounted: false,
      isStatusMessage: true,
    }]);
    customMessagesRegistered = true;
  }

  const connection = await chat.NCEngine.connect({ token: session.token });
  if (!connection.isOk) {
    throw new Error(nexconnResultError(connection, 'Could not connect to Nexconn'));
  }
  return { chat, call: includeCall ? call : null };
}

