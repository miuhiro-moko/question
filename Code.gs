// 基本定数 
const SPREADSHEET_ID = 'MY_SPRED_SHEET_ID'; // スプレッドシート ID
const IMAGE_FOLDER   = 'DRIVE_FOLDER_ID';                          // 画像保存フォルダ ID
const MAIL_TO        = 'teacher@example.com';                           // 通知先メールアドレス

const SLOT_SHEET = '予約枠';   // B:時間  C:上限  D:予約人数  E:TRUE/FALSE
const LOG_SHEET  = '質問ログ'; // 予約情報を追加するシート名

//  画面切り替え 
function doGet(e){
  // ?admin=true なら管理者画面、それ以外は予約フォーム
  return (e.parameter.admin === 'true')
    ? HtmlService.createTemplateFromFile('Admin').evaluate().setTitle('管理者用予約状況')
    : HtmlService.createTemplateFromFile('Index').evaluate().setTitle('質問予約フォーム');
}

// 送信直前の「空き確認」
function isSlotAvailable(timeSlot){
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SLOT_SHEET);
  const data  = sheet.getRange(2,2,sheet.getLastRow()-1,4).getDisplayValues(); // B~E
  for (let r of data){
    if (r[0] === timeSlot) return r[3] === 'TRUE'; // E列 TRUE/FALSE
  }
  return false; // 見つからなければ不可
}

// 予約枠リストを返す 
function getSlotList(){
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SLOT_SHEET);
  const data  = sheet.getRange(2,2,sheet.getLastRow()-1,4).getDisplayValues();
  return data.map(r => ({ time:r[0], available:r[3]==='TRUE' }));
}

// 予約受付メイン 
function submitReservation(data){
  const lock = LockService.getScriptLock();       // スクリプト全体で共有ロック
  try{
    lock.waitLock(30000);                        // 最大 30 秒待機（取れないと例外）

    // ① ロック下で空き再確認 & 予約人数 D列を +1
    const slotInfo = reserveSlot(data.timeSlot);  // {row,newCount}

    // ② 画像を Drive に保存（複数）
    const fileIds = [];
    if (Array.isArray(data.imageData)){
      data.imageData.forEach((b64,i)=>{
        const id = saveImage(b64,
          `${data.timeSlot}_${data.studentNumber}_${i+1}.jpg`);
        fileIds.push(id);
      });
    }

    // ③ 質問ログシートに記録
    SpreadsheetApp.openById(SPREADSHEET_ID)
      .getSheetByName(LOG_SHEET)
      .appendRow([
        data.timeSlot,
        data.grade,
        data.class,
        data.studentNumber,
        data.subject,
        data.textbook,
        data.page,
        data.question,
        fileIds.join(','),
        new Date(),
        '予約済み'
      ]);

    // ④ メール通知
    sendMail(data, fileIds, slotInfo.newCount);

    return {result:'success'};

  }catch(err){
    // 送信者側へエラーメッセージを返す
    return {result:'error', message: err.message};
  }finally{
    lock.releaseLock();           // 必ずロックを解放
  }
}

// =予約枠シートで D列を +1 
function reserveSlot(time){
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SLOT_SHEET);
  const data  = sheet.getRange(2,2,sheet.getLastRow()-1,4).getDisplayValues(); // B~E

  for (let i=0;i<data.length;i++){
    if (data[i][0] === time){
      if (data[i][3] !== 'TRUE')               // E列が FALSE → 満席
        throw new Error('その枠は満席になりました。別の時間を選んでください');

      const row = i + 2;                       // 実際のシート行（1 行目はヘッダー）
      const cell = sheet.getRange(row, 4);     // D列: 予約人数
      const newCount = cell.getValue() + 1;    // インクリメント
      cell.setValue(newCount);
      // E列 (TRUE/FALSE) はシート側の関数で自動更新される
      return {row, newCount};
    }
  }
  throw new Error('指定した予約枠が見つかりません');
}

// Drive に画像保存（リンク公開）
function saveImage(base64,fileName){
  const m = base64.match(/^data:(.+?);base64,(.+)$/);
  if (!m) throw new Error('画像の解析に失敗しました');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName);
  const file = DriveApp.getFolderById(IMAGE_FOLDER).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

// メール通知 
function sendMail(info, fileIds, newCount){
  let body =
`新しい予約が入りました

【予約枠】 ${info.timeSlot}
【現在の予約人数】 ${newCount}

【学年】 ${info.grade}
【組・番号】 ${info.class}-${info.studentNumber}
【科目】 ${info.subject}
【教材・ページ】 ${info.textbook} / ${info.page}

【質問内容】
${info.question}
`;
  if (fileIds.length){
    body += '\n【画像リンク】\n';
    fileIds.forEach(id=>{
      body += 'https://drive.google.com/file/d/' + id + '/view?usp=sharing\n';
    });
  }
  MailApp.sendEmail(MAIL_TO, '新規予約: ' + info.timeSlot, body);
}
