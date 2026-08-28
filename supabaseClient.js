// Supabase 專案連線設定
// 建立專案步驟見 README.md；URL 與 anon key 在 Project Settings → API 取得。
// anon key 是公開金鑰，設計上就是給前端用的，資料安全靠 Supabase 的 Row Level Security 規則。
const SUPABASE_URL = 'https://xcwmjckerzxslvnaibdl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3cfKPcmbYUvsnIqFdtufkw_NI5f20q9';

export const configured = !SUPABASE_URL.startsWith('YOUR_') && !SUPABASE_ANON_KEY.startsWith('YOUR_');

// SDK 用動態 import 載入：健身房離線時若模組還沒被瀏覽器快取過，
// 不會讓整支 app.js 直接掛掉，只是那次連不上雲端而已。
let loadPromise = null;
export function getSupabase(){
  if(!configured) return Promise.resolve(null);
  if(!loadPromise){
    loadPromise = import('https://esm.sh/@supabase/supabase-js@2')
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true }
      }))
      .catch(e => { console.warn('Supabase SDK 載入失敗（可能離線）', e); return null; });
  }
  return loadPromise;
}
