// ===============================================================
// CONFIGURATION
// ===============================================================
const SPREADSHEET_ID = '1chyphNjNYhicGaGfSzWK9tWO4pTtzmVzbbmewlJ16Zk'; // <--- !!! ใส่ ID ของ Google Sheet ที่นี่ !!!
const FEEDBACK_SHEET_NAME = 'Feedback';
const QUESTIONS_SHEET_NAME = 'Questions';
const SURVEY_LIST_SHEET_NAME = 'Survey_List';
const ADMIN_PASSWORD_FALLBACK = '147258'; // <--- รหัสผ่านเริ่มต้น
const ADMIN_PASSWORD_KEY = 'ADMIN_PASSWORD';
const MASTER_KEY = '0849536654'; // <--- รหัสผ่านหลัก

// ===============================================================
// WEB APP ROUTER & URL
// ===============================================================
function doGet(e) {
  const page = e.parameter.page;
  if (page === 'admin' || page === 'dashboard') {
    return HtmlService.createHtmlOutputFromFile('Admin').setTitle("Admin Panel");
  }
  if (page === 'survey') {
    return HtmlService.createHtmlOutputFromFile('Survey').setTitle("แบบสำรวจออนไลน์");
  }
  return HtmlService.createHtmlOutputFromFile('Index').setTitle("ระบบแบบสำรวจอเนกประสงค์");
}

function getWebAppUrl() {
  return ScriptApp.getService().getUrl();
}

// ===============================================================
// PAYLOAD LOADERS
// ===============================================================
function getUniversalPayload(params) {
  try {
    let survey;
    if (params && params.previewId) {
      survey = getSurveyDetails_(params.previewId);
      if (!survey) throw new Error("ไม่พบแบบสำรวจสำหรับดูตัวอย่าง (ID: " + params.previewId + ")");
    } else {
      survey = getLatestActiveSurvey_();
      if (!survey) throw new Error("ไม่พบแบบสำรวจที่เปิดใช้งานในขณะนี้");
    }
    const questionsRaw = getQuestionsForSurvey_(survey.id);
    const sections = [];
    let currentSection = null;
    questionsRaw.forEach(q => {
      if (q.type === 'SECTION_HEADER') {
        currentSection = { title: q.text, questions: [] };
        sections.push(currentSection);
      } else if ((q.type === 'SCALE_QUESTION' || q.type === 'CHOICE_QUESTION') && currentSection) {
        currentSection.questions.push({ id: q.id, text: q.text, type: q.type, options: q.options });
      }
    });
    return { success: true, survey: survey, sections: sections };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getAdminPayload() {
  try {
    const surveys = getSurveyList_();
    const allQuestions = getQuestions_();
    const webAppUrl = getWebAppUrl();
    return { success: true, surveys: surveys, allQuestions: allQuestions, webAppUrl: webAppUrl };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getDashboardPayload(filters) {
  try {
    if (!filters || !filters.surveyId) { throw new Error("Survey ID is required."); }
    const surveyId = filters.surveyId;
    const survey = getSurveyDetails_(surveyId);
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(FEEDBACK_SHEET_NAME);
    if (sheet.getLastRow() < 2) return { success: true, dashboardData: { noData: true, surveyTitle: survey.title } };
    
    const allData = sheet.getDataRange().getValues();
    const headers = allData.shift();
    const dataRows = allData.filter(row => row[0] === surveyId);
    if (dataRows.length === 0) return { success: true, dashboardData: { noData: true, surveyTitle: survey.title } };

    const headerMap = new Map(headers.map((h, i) => [h, i]));
    const identifier1Index = headerMap.get("Identifier1_Response");
    const identifier2Index = headerMap.get("Identifier2_Response");
    const feedbackIndex = headerMap.get("Feedback");
    const avgScoreIndex = headerMap.get("AvgScore");
    
    let feedbackComments = [];
    let evaluators = [];

    dataRows.forEach(row => {
      if (survey.identifier1_active || survey.identifier2_active) {
          evaluators.push({
            identifier1: (identifier1Index !== undefined && row[identifier1Index]) ? row[identifier1Index] : "ไม่ระบุ",
            identifier2: (identifier2Index !== undefined && row[identifier2Index]) ? row[identifier2Index] : "ไม่ระระบุ"
          });
      }
      if (feedbackIndex !== undefined && row[feedbackIndex] && row[feedbackIndex].toString().trim() !== "-") {
        const respondent = (identifier1Index !== undefined && row[identifier1Index] && row[identifier1Index] !== '-') ? row[identifier1Index] : "ไม่ระบุ";
        const score = (avgScoreIndex !== undefined && row[avgScoreIndex] && parseFloat(row[avgScoreIndex]) > 0) ? parseFloat(row[avgScoreIndex]).toFixed(2) : 'N/A';
        feedbackComments.push({ respondent: respondent, comment: row[feedbackIndex].toString().trim(), score: score });
      }
    });

    const scaleQuestions = getQuestionsForSurvey_(surveyId).filter(q => q.type === 'SCALE_QUESTION');
    
    if (scaleQuestions.length === 0) {
      return { success: true, dashboardData: {
          surveyTitle: survey.title,
          totalResponses: dataRows.length,
          overallAverageScore: 'N/A',
          overallSatisfactionPercent: 'N/A',
          averageScoresPerQuestion: [],
          questionLabels: [],
          feedbackComments: feedbackComments.reverse(),
          satisfactionSummary: null,
          evaluators: evaluators,
          survey: survey
        }
      };
    }
    
    let questionScores = Array(scaleQuestions.length).fill(0);
    let questionCounts = Array(scaleQuestions.length).fill(0);
    
    dataRows.forEach(row => {
      scaleQuestions.forEach((q, i) => {
        const qHeader = headers.find(h => h.startsWith(q.id + '_'));
        const qHeaderIndex = headerMap.get(qHeader);
        if (qHeaderIndex !== undefined) {
          const score = parseFloat(row[qHeaderIndex]);
          if (!isNaN(score)) { questionScores[i] += score; questionCounts[i]++; }
        }
      });
    });

    const averageScoresPerQuestion = questionScores.map((total, i) => (questionCounts[i] > 0 ? (total / questionCounts[i]).toFixed(2) : "0.00"));
    const scoresWithQuestions = scaleQuestions.map((q, i) => ({ question: q.text, score: parseFloat(averageScoresPerQuestion[i]) }));
    scoresWithQuestions.sort((a, b) => b.score - a.score);

    const highestScore = scoresWithQuestions.length > 0 ? scoresWithQuestions[0].score : 0;
    const lowestScore = scoresWithQuestions.length > 0 ? scoresWithQuestions[scoresWithQuestions.length - 1].score : 0;

    const satisfactionSummary = {
      highest: scoresWithQuestions.filter(item => item.score === highestScore),
      lowest: scoresWithQuestions.filter(item => item.score === lowestScore)
    };
    
    const overallScoreSum = questionScores.reduce((sum, score) => sum + score, 0);
    const overallScoreCount = questionCounts.reduce((sum, count) => sum + count, 0);
    const overallAverageScore = overallScoreCount > 0 ? overallScoreSum / overallScoreCount : 0;
    
    const dashboardData = {
      surveyTitle: survey.title,
      totalResponses: dataRows.length,
      overallAverageScore: overallAverageScore.toFixed(2),
      overallSatisfactionPercent: ((overallAverageScore / 5) * 100).toFixed(2),
      averageScoresPerQuestion: averageScoresPerQuestion,
      questionLabels: scaleQuestions.map(q => q.text),
      feedbackComments: feedbackComments.reverse(),
      satisfactionSummary: satisfactionSummary,
      evaluators: evaluators,
      survey: survey
    };
    return { success: true, dashboardData: dashboardData };
  } catch (e) {
    return { success: false, message: "Error in getDashboardPayload: " + e.message };
  }
}

// ===============================================================
// ADMIN & SETTINGS FUNCTIONS
// ===============================================================

function checkAdminPassword(password) {
  const scriptProperties = PropertiesService.getScriptProperties();
  let storedPassword = scriptProperties.getProperty(ADMIN_PASSWORD_KEY);
  if (!storedPassword) {
    scriptProperties.setProperty(ADMIN_PASSWORD_KEY, ADMIN_PASSWORD_FALLBACK);
    storedPassword = ADMIN_PASSWORD_FALLBACK;
  }
  return password === storedPassword;
}

function checkPasswordForUpdate_(password) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const storedPassword = scriptProperties.getProperty(ADMIN_PASSWORD_KEY) || ADMIN_PASSWORD_FALLBACK;
  return (password === storedPassword) || (password === MASTER_KEY);
}

function updateAdminPassword(data) {
  try {
    if (!data || !data.currentPassword || !data.newPassword) {
      throw new Error("ข้อมูลไม่ครบถ้วน");
    }
    if (!checkPasswordForUpdate_(data.currentPassword)) {
      return { success: false, message: "รหัสผ่านปัจจุบันไม่ถูกต้อง" };
    }
    if (data.newPassword.length < 6) {
      return { success: false, message: "รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร" };
    }
    PropertiesService.getScriptProperties().setProperty(ADMIN_PASSWORD_KEY, data.newPassword);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function setActiveSurvey(surveyId) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SURVEY_LIST_SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: true };
    const range = sheet.getRange(2, 1, lastRow - 1, 4);
    const values = range.getValues();
    values.forEach(row => row[3] = (row[0] === surveyId));
    range.setValues(values);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function saveSurvey(surveyData) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SURVEY_LIST_SHEET_NAME);
    const lastRow = sheet.getLastRow();
    const surveyIds = lastRow > 1 ? sheet.getRange("A2:A" + lastRow).getValues().flat() : [];
    let rowIndex = surveyIds.indexOf(surveyData.id) + 2;
    let surveyIdToReturn = surveyData.id;
    const newValues = [
      surveyData.title, surveyData.intro,
      surveyData.identifier1_active, surveyData.identifier1_label,
      surveyData.identifier2_active, surveyData.identifier2_label,
      surveyData.identifier_header, surveyData.feedback_header
    ];
    if (rowIndex > 1) {
      sheet.getRange(rowIndex, 2, 1, 8).setValues([newValues]);
    } else {
      const newId = "S_" + new Date().getTime();
      sheet.appendRow([newId, newValues[0], newValues[1], false, ...newValues.slice(2)]);
      surveyIdToReturn = newId;
    }
    return { success: true, surveyId: surveyIdToReturn };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function saveQuestionsForSurvey(surveyId, questionsData) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(QUESTIONS_SHEET_NAME);
    if (sheet.getLastRow() > 1) {
      const allSurveyIds = sheet.getRange("A:A").getValues().flat();
      const rowsToDelete = allSurveyIds.reduce((acc, id, index) => {
        if (id === surveyId) acc.push(index + 1);
        return acc;
      }, []);
      rowsToDelete.reverse().forEach(rowIndex => sheet.deleteRow(rowIndex));
    }
    const validQuestions = questionsData.filter(q => q.text && q.text.trim() !== "");
    if (validQuestions.length > 0) {
      const rows = validQuestions.map(q => [surveyId, q.id, q.type, q.text.trim(), q.order, q.options || null]);
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    }
    syncFeedbackSheetHeaders_();
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function submitFeedback(data) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(FEEDBACK_SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const values = new Array(headers.length).fill(null);
    const headerMap = new Map(headers.map((h, i) => [h, i]));
    values[headerMap.get("SurveyID")] = data.surveyId;
    values[headerMap.get("Timestamp")] = new Date();
    values[headerMap.get("Identifier1_Response")] = data.identifier1_response || "-";
    values[headerMap.get("Identifier2_Response")] = data.identifier2_response || "-";
    values[headerMap.get("Feedback")] = data.feedbackText || "-";
    let totalScore = 0, count = 0;
    data.responses.forEach(response => {
      const questionId = response[0];
      const answer = response[1];
      const qHeader = headers.find(h => h.startsWith(questionId + '_'));
      const qHeaderIndex = headerMap.get(qHeader);
      if (qHeaderIndex !== undefined) {
          values[qHeaderIndex] = answer;
          const score = parseFloat(answer);
          if (!isNaN(score)) { totalScore += score; count++; }
      }
    });
    const averageScore = count > 0 ? totalScore / count : 0;
    let satisfactionLevel = "N/A";
    if (count > 0) {
      if (averageScore >= 4.5) satisfactionLevel = "😃 ยอดเยี่ยม";
      else if (averageScore >= 3.5) satisfactionLevel = "😊 ดี";
      else if (averageScore >= 1.5) satisfactionLevel = "😟 พอใช้";
      else if (averageScore > 0) satisfactionLevel = "😡 ต้องปรับปรุง";
    }
    values[headerMap.get("Satisfaction")] = satisfactionLevel;
    values[headerMap.get("AvgScore")] = averageScore;
    values[headerMap.get("AvgPercent")] = count > 0 ? (averageScore / 5) : 0;
    sheet.appendRow(values);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ===============================================================
// INTERNAL HELPER FUNCTIONS
// ===============================================================
function getSurveyList_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SURVEY_LIST_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  return data.map(row => ({
    id: row[0], title: row[1], intro: row[2], isActive: row[3] === true,
    identifier1_active: row[4] === true, identifier1_label: row[5],
    identifier2_active: row[6] === true, identifier2_label: row[7],
    identifier_header: row[8], feedback_header: row[9]
  }));
}

function getQuestions_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(QUESTIONS_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues()
    .map(row => ({ surveyId: row[0], id: row[1], type: row[2], text: row[3], order: row[4], options: row[5] }))
    .sort((a, b) => a.order - b.order);
}

function getQuestionsForSurvey_(surveyId) {
  return getQuestions_().filter(q => q.surveyId === surveyId);
}

function getSurveyDetails_(surveyId) {
  const survey = getSurveyList_().find(s => s.id === surveyId);
  if (!survey) throw new Error(`Survey with ID "${surveyId}" not found.`);
  return survey;
}

function getLatestActiveSurvey_() {
  const activeSurveys = getSurveyList_().filter(s => s.isActive);
  return activeSurveys.pop() || null;
}

function syncFeedbackSheetHeaders_() {
    const allQuestions = getQuestions_().filter(q => q.type === 'SCALE_QUESTION' || q.type === 'CHOICE_QUESTION');
    const questionMap = new Map();
    allQuestions.forEach(q => {
        const qId = q.id;
        if (!questionMap.has(qId) || questionMap.get(qId).length < q.text.length) {
            questionMap.set(qId, `${q.id}_${q.text}`);
        }
    });
    const sortedQuestionIds = Array.from(questionMap.keys()).sort((a,b) => {
      const numA = parseInt(a.replace (/[^0-9]/g, ''), 10);
      const numB = parseInt(b.replace (/[^0-9]/g, ''), 10);
      return numA - numB;
    });
    const questionHeaders = sortedQuestionIds.map(id => questionMap.get(id));
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(FEEDBACK_SHEET_NAME);
    const prefixHeaders = ["SurveyID", "Timestamp", "Identifier1_Response", "Identifier2_Response"];
    const suffixHeaders = ["Feedback", "Satisfaction", "AvgScore", "AvgPercent"];
    const targetHeaders = [...prefixHeaders, ...questionHeaders, ...suffixHeaders];
    sheet.setFrozenColumns(4);
    sheet.getRange("1:1").clearContent();
    sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
}
