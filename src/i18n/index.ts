// i18n/index.ts
//
// Bot copy in the user's language. Teams sends the client language on every
// activity (`activity.locale`, e.g. "es-MX"), so the bot answers in Spanish
// for any `es-*` client and in English for everything else. Only bot copy is
// translated: LNbits wallet names, display names, amounts and the reward
// label are data and pass through untouched, and the command words people
// type stay English (they are matched by SSOCommandMap).
//
// The dictionaries are typed objects rather than JSON files so a Spanish key
// that is missing fails the build, and `{{name}}` placeholders are filled by
// a function replacer so a parameter containing `$&` is copied literally.

export type Locale = 'en' | 'es';

export const DEFAULT_LOCALE: Locale = 'en';

export const en = {
  genericError:
    "D'oh! Something went wrong on my end, so that didn't complete. Please try again in a moment.",
  userFacingError: "D'oh! {{message}}",
  unrecognizedCommand:
    "D'oh! I didn't recognize that command. Here's what I can help with:\n{{commands}}\nJust type one of those to get started!",
  welcome:
    "Hi, I'm Zaplie! I help you send zaps to your colleagues. Here are the commands I understand:\n{{commands}}\nType one of those to get started!",
  agentNoReply:
    "D'oh! I'm sorry, but I didn't recognize that command. But don't worry, I'm always getting better!",
  zapCardUnidentified:
    'That zap card cannot be identified, so it was not submitted. Please start a new zap.',
  senderUnverified:
    'Could not verify your sender identity, so no zaps were sent.',
  noRecipients: 'No valid recipients were selected, so no zaps were sent.',
  zapNeedsMessage: 'Your zap needs a message, so no zaps were sent.',
  selfZap: 'You cannot zap yourself, so no zaps were sent.',
  submitStillChecking:
    'One or more payments from this zap still need checking, so nothing was retried.',
  submitAlreadyHandled:
    'That zap card was already submitted, so nothing was sent again.',
  noZapsConfirmed: 'No zaps were confirmed.',
  noZapsSent: 'No zaps were sent.',
  couldNotComplete: 'Could not complete: {{recipients}}.',
  outcomeUncertain:
    'Payment outcome uncertain for: {{recipients}} — an admin should verify before retrying.',
  zapSent:
    'Awesome! You sent {{amount}} {{rewardName}} to your colleague with a zap!',
  amountInvalid:
    'You must specify a whole number between 1 and {{max}} {{rewardName}}.',
  balanceUnreadable: 'Could not read your live balance, so no zaps were sent.',
  budgetExceeded:
    'That would send {{total}} {{rewardName}} across {{count}} recipient(s) but your balance is {{balance}}. No zaps were sent.',
  balanceUserNotFound: 'User not found.',
  balanceNoWallets: 'No wallets found for the user.',
  balanceUnavailable:
    'Balance information not available for wallet {{walletId}}.',
  balanceLine:
    'Your {{walletName}} wallet has a balance of {{balance}} {{rewardName}}.',
  balanceError: 'Sorry, something went wrong while showing your balance.',
  workSignalsConnected:
    'Work signals connected — ask me about recent meetings or collaborators!',
  signInFailed:
    'Sign-in could not be completed. Type "{{command}}" to try again.',
} as const;

export type MessageKey = keyof typeof en;

// Every English key must have Spanish copy: a missing one is a compile error.
export const es: Record<MessageKey, string> = {
  genericError:
    '¡Ups! Algo salió mal de mi lado y no se completó. Inténtalo de nuevo en un momento.',
  userFacingError: '¡Ups! {{message}}',
  unrecognizedCommand:
    '¡Ups! No reconocí ese comando. Esto es lo que puedo hacer:\n{{commands}}\nEscribe uno de esos para empezar.',
  welcome:
    '¡Hola! Soy Zaplie y te ayudo a enviar zaps a tus colegas. Estos son los comandos que entiendo:\n{{commands}}\nEscribe uno de esos para empezar.',
  agentNoReply:
    '¡Ups! Lo siento, no reconocí ese comando. Pero tranquilo, cada vez aprendo más.',
  zapCardUnidentified:
    'No se pudo identificar esa tarjeta de zap, así que no se envió. Empieza un zap nuevo.',
  senderUnverified:
    'No pude verificar tu identidad como remitente, así que no se envió ningún zap.',
  noRecipients:
    'No se seleccionó ningún destinatario válido, así que no se envió ningún zap.',
  zapNeedsMessage:
    'Tu zap necesita un mensaje, así que no se envió ningún zap.',
  selfZap:
    'No puedes enviarte un zap a ti mismo, así que no se envió ningún zap.',
  submitStillChecking:
    'Uno o más pagos de este zap todavía están por confirmar, así que no se reintentó nada.',
  submitAlreadyHandled:
    'Esa tarjeta de zap ya se había enviado, así que no se envió nada de nuevo.',
  noZapsConfirmed: 'No se confirmó ningún zap.',
  noZapsSent: 'No se envió ningún zap.',
  couldNotComplete: 'No se pudo completar: {{recipients}}.',
  outcomeUncertain:
    'Resultado del pago incierto para: {{recipients}}; un administrador debe verificarlo antes de reintentar.',
  zapSent:
    '¡Genial! Enviaste {{amount}} {{rewardName}} a tu colega con un zap.',
  amountInvalid:
    'Debes indicar un número entero entre 1 y {{max}} {{rewardName}}.',
  balanceUnreadable:
    'No pude leer tu saldo actual, así que no se envió ningún zap.',
  budgetExceeded:
    'Eso enviaría {{total}} {{rewardName}} entre {{count}} destinatario(s), pero tu saldo es {{balance}}. No se envió ningún zap.',
  balanceUserNotFound: 'Usuario no encontrado.',
  balanceNoWallets: 'No se encontraron carteras para el usuario.',
  balanceUnavailable:
    'La información de saldo no está disponible para la cartera {{walletId}}.',
  balanceLine:
    'Tu cartera {{walletName}} tiene un saldo de {{balance}} {{rewardName}}.',
  balanceError: 'Lo siento, algo salió mal al mostrar tu saldo.',
  workSignalsConnected:
    'Señales de trabajo conectadas. Pregúntame por reuniones o colaboradores recientes.',
  signInFailed:
    'No se pudo completar el inicio de sesión. Escribe "{{command}}" para intentarlo de nuevo.',
};

export type Dictionaries = Record<Locale, Record<MessageKey, string>>;

const dictionaries: Dictionaries = { en, es };

export type MessageParams = Record<string, string | number>;

/**
 * Maps the locale Teams sends (`activity.locale`) to a supported one.
 * Anything that is not Spanish, including a missing or malformed value,
 * resolves to English; a language mismatch must never fail a turn.
 */
export function resolveLocale(activityLocale: unknown): Locale {
  if (typeof activityLocale !== 'string') {
    return DEFAULT_LOCALE;
  }
  const primary = activityLocale.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'es' ? 'es' : DEFAULT_LOCALE;
}

/**
 * Renders a message from an explicit set of dictionaries. Exported for the
 * tests that pin the fallback; production code uses `t`.
 */
export function translateWith(
  dicts: Dictionaries,
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  let template = dicts[locale]?.[key];
  if (!template) {
    if (locale !== DEFAULT_LOCALE) {
      console.warn(
        `i18n: no ${locale} copy for "${key}", falling back to ${DEFAULT_LOCALE}`,
      );
    }
    template = dicts[DEFAULT_LOCALE][key];
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(params?.[name] ?? ''),
  );
}

/** Renders bot copy in the given language, with `{{name}}` placeholders filled. */
export const t = (
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string => translateWith(dictionaries, locale, key, params);
