declare module "node-telegram-bot-api" {
  // Minimal ambient declaration to satisfy TypeScript without installing @types.
  export default class TelegramBot {
    constructor(token: string, options?: any);
    on(event: string, listener: (...args: any[]) => void): void;
    onText(regex: RegExp, callback: (msg: any, match?: RegExpExecArray | null) => any): void;
    sendMessage(chatId: number, text: string, options?: any): Promise<any>;
    setMyCommands(commands: Array<{ command: string; description: string }>): Promise<any>;
    answerCallbackQuery(callbackQueryId: string, options?: any): Promise<any>;
    getFile(fileId: string): Promise<{ file_path?: string }>;
  }

  // Minimal augmentation for copy_text buttons (Bot API 7.6+)
  export interface InlineKeyboardButton {
    text?: string;
    callback_data?: string;
    url?: string;
    copy_text?: { text: string };
  }
}