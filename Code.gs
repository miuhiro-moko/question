const SPREADSHEET_ID = "スプレッドシートのID";
const MAIL_ADDRESS = "example@example.com";
const FOLDER_ID="写真保存用フォルダのID"

// エントリーポイント：URL パラメータ admin=true に応じて画面を切り替え
function doGet(e) {
  if (e.parameter.admin === "true") {
    return HtmlService.createTemplateFromFile('Admin').evaluate().setTitle("管理者用予約状況");
  } else {
    return HtmlService.createTemplateFromFile('Index').evaluate().setTitle("質問予約フォーム");
  }
}

// 予約情報を「質問ログ」シートに登録し、
// 「予約枠」シートの対象時間の予約人数（D列）を更新し、メール通知する
function submitReservation(reservationData) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 同時アクセス対策：最大30秒待機
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var logSheet = ss.getSheetByName("質問ログ");

    // もし予約時に写真がアップロードされていれば、フォルダへ保存しファイルIDを取得
    if (reservationData.imageData) {
      var imageFileId = saveUploadedImage(
                            reservationData.imageData,
                            reservationData.timeSlot + "_" + reservationData.studentNumber + ".jpg"
                         );
      reservationData.imageFileId = imageFileId;
    }
    
    // 「質問ログ」シートに予約情報を追加
    logSheet.appendRow([
      reservationData.timeSlot,
      reservationData.grade,
      reservationData.class,
      reservationData.studentNumber,
      reservationData.subject,
      reservationData.textbook,
      reservationData.page,
      reservationData.question,
      (reservationData.imageFileId ? reservationData.imageFileId : ""),
      new Date(),
      "予約済み"
    ]);
    
    // 「予約枠」シートの対象の時間帯の予約人数（D列）を +1 する
    updateReservationSlot(reservationData.timeSlot);
    
    // 予約完了後にメール通知を行う（画像がある場合は公開URLを添付）
    sendNotification(reservationData);
    
    return { result: "success" };
  } catch (err) {
    return { result: "error", message: err.message };
  } finally {
    lock.releaseLock();
  }
}

// 指定された時間帯（例："15:40"）の「予約枠」シートにおいて、予約人数（D列）を+1する処理
// ※ E列（予約可否）はスプレッドシート側の関数で管理するため、こちらでは変更しない
function updateReservationSlot(timeSlot) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var slotSheet = ss.getSheetByName("予約枠");
  
  var lastRow = slotSheet.getLastRow();
  if (lastRow < 2) throw new Error("予約枠シートにデータがありません");
  
  // B列（予約可能時間）の値（2行目以降）を取得
  var timeValues = slotSheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
  var targetRow = null;
  for (var i = 0; i < timeValues.length; i++) {
    if (timeValues[i][0] === timeSlot) {
      targetRow = i + 2; // 実際のシート行番号（ヘッダーが1行目なので2行目以降）
      break;
    }
  }
  
  if (!targetRow) throw new Error("指定した予約時間 '" + timeSlot + "' の行が見つかりません");
  
  // D列（予約人数）の取得・更新
  var currentCountCell = slotSheet.getRange(targetRow, 4);
  var currentCount = currentCountCell.getValue();
  currentCount++;
  currentCountCell.setValue(currentCount);
}

// 予約枠シートから、各行のB列（予約可能時間）とE列（予約可否）を取得してオブジェクト配列として返す
// 例: [{ time: "15:40", available: true }, ...]
function getSlotList() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var slotSheet = ss.getSheetByName("予約枠");
  if (!slotSheet) throw new Error("予約枠シートが見つかりません");
  
  var lastRow = slotSheet.getLastRow();
  if (lastRow < 2) return [];
  
  // 2行目以降のB～E列を取得（B: 時間, E: 予約可否）
  var data = slotSheet.getRange(2, 2, lastRow - 1, 4).getDisplayValues();
  var slots = [];
  for (var i = 0; i < data.length; i++) {
    slots.push({ time: data[i][0], available: (data[i][3] === "TRUE") });
  }
  return slots;
}

// 写真（Base64 エンコードされた画像データ）を指定フォルダに保存し、保存したファイルのIDを返す
// 保存後はファイルの共有設定を「リンクを知っている全員が閲覧可能」に変更する
function saveUploadedImage(base64Data, fileName) {
  var matches = base64Data.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!matches || matches.length < 3) {
    throw new Error("無効な画像データです");
  }
  var contentType = matches[1];
  var data = Utilities.base64Decode(matches[2]);
  var blob = Utilities.newBlob(data, contentType, fileName);
  
  var folderId = FOLDER_ID;  // 
  var folder = DriveApp.getFolderById(folderId);
  var file = folder.createFile(blob);
  // ファイルの共有設定を「リンクを知っている全員が閲覧可能」にする
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  return file.getId();
}

// 予約が完了した際に、メールで通知する機能
// 画像がある場合は、Googleドライブ上の公開URLをメール本文に含める
function sendNotification(reservationData) {
  // 送信先のメールアドレス（必要に応じて変更してください）
  var teacherEmail = MAIL_ADDRESS;
  
  // メールの件名・本文の組み立て
  var subject = "新規予約: " + reservationData.timeSlot;
  var body = "新しい予約が入りました。\n\n" +
             "【予約枠】 " + reservationData.timeSlot + "\n" +
             "【学年】 " + reservationData.grade + "\n" +
             "【組・番号】 " + reservationData.class + " - " + reservationData.studentNumber + "\n" +
             "【科目】 " + reservationData.subject + "\n" +
             "【教材・ページ】 " + reservationData.textbook + " / " + reservationData.page + "\n" +
             "【質問内容】\n" + reservationData.question + "\n";
  if (reservationData.imageFileId) {
    // 画像の公開URLを生成
    var imageUrl = "https://drive.google.com/file/d/" + reservationData.imageFileId + "/view?usp=sharing";
    body += "\n【画像】\n" + imageUrl + "\n";
  }
  
  // メール送信（メール本文はプレーンテキスト）
  MailApp.sendEmail(teacherEmail, subject, body);
}
