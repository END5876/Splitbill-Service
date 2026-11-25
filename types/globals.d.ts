// 型別檢查用（npm run typecheck）：執行時不會載入
interface Error { code?: string; status?: number }
declare namespace Express {
  interface Request {
    id?: string;
    /** 身分（lib/auth.js）：service＝Bot 金鑰，user＝登入者，null＝沒有身分 */
    principal?: any;
    /** 舊網址帶的伺服器 ID（lib/legacyPaths.js） */
    legacyGuildId?: string;
  }
}
