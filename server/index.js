require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// ── FIREBASE ADMIN ──
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CREDENTIALS)),
    projectId: 'eduai-assistant-9fb47'
  });
}

// ── GOOGLE SHEETS SETUP ──
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Лист1';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ── READ PROFILE ──
async function getStudentProfile(studentId) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
    });
    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === studentId);
    if (row) {
      return {
        userId: row[0],
        level: row[1] || 'beginner',
        correctAnswers: parseInt(row[2]) || 0,
        wrongAnswers: parseInt(row[3]) || 0,
        weakTopics: row[4] ? row[4].split(',').filter(Boolean) : [],
        lastActive: row[5] || '',
        totalSessions: parseInt(row[6]) || 0,
      };
    }
    return {
      userId: studentId,
      level: 'beginner',
      correctAnswers: 0,
      wrongAnswers: 0,
      weakTopics: [],
      lastActive: '',
      totalSessions: 0,
    };
  } catch (err) {
    console.error('Error reading Sheets:', err.message);
    return {
      userId: studentId,
      level: 'beginner',
      correctAnswers: 0,
      wrongAnswers: 0,
      weakTopics: [],
      lastActive: '',
      totalSessions: 0,
    };
  }
}

// ── SAVE PROFILE ──
async function saveStudentProfile(profile) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:A`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === profile.userId);
    const now = new Date().toISOString();
    const values = [[
      profile.userId,
      profile.level,
      profile.correctAnswers,
      profile.wrongAnswers,
      profile.weakTopics.slice(-15).join(','),
      now,
      profile.totalSessions,
    ]];
    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:G`,
        valueInputOption: 'RAW',
        resource: { values },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${rowIndex + 1}:G${rowIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values },
      });
    }
    console.log('✅ Profile saved:', profile.userId, '| Level:', profile.level);
  } catch (err) {
    console.error('Error saving Sheets:', err.message);
  }
}

// ── ANALYZE CONVERSATION FOR ADAPTATION ──
function analyzeConversation(messages) {
  if (messages.length < 2) return { hasConfusion: false, hasSuccess: false };
  
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const prevAI = [...messages].slice(0, -1).reverse().find(m => m.role === 'assistant');
  
  if (!lastUser || !prevAI) return { hasConfusion: false, hasSuccess: false };

  const aiText = prevAI.content.toLowerCase();
  const userText = (lastUser.content || '').toLowerCase();

  // AI задавал тест с вариантами?
  const hadQuestion = (aiText.includes('a)') || aiText.includes('**a)') || aiText.includes('a)')) &&
    (aiText.includes('b)') || aiText.includes('**b)')) && aiText.includes('?');

  if (!hadQuestion) {
    const confusionWords = ["don't understand", "not clear", "confused", "не понимаю", "непонятно", "не знаю", "помогите", "не понял"];
    return { hasConfusion: confusionWords.some(w => userText.includes(w)), hasSuccess: false };
  }

  // Пользователь ответил одной буквой или словом — считаем попытку
  const giveUp = ["i don't know", "no idea", "idk", "не знаю", "пропусти", "понятия не имею"];
  if (giveUp.some(w => userText.includes(w))) return { hasConfusion: true, hasSuccess: false };

  // Если ответ короткий (буква/слово) — засчитываем как попытку, смотрим ответ AI
  const lastAI = messages[messages.length - 1];
  if (lastAI && lastAI.role === 'assistant') {
    const nextText = lastAI.content.toLowerCase();
    const isCorrect = ['correct!', 'right!', 'exactly!', 'perfect!', 'правильно!', 'верно!', 'отлично!', '✅'].some(w => nextText.startsWith(w) || nextText.includes(w));
    const isWrong = ['incorrect', 'wrong', 'not quite', 'неправильно', 'неверно', 'к сожалению', '❌'].some(w => nextText.includes(w));
    if (isCorrect) return { hasConfusion: false, hasSuccess: true };
    if (isWrong) return { hasConfusion: true, hasSuccess: false };
  }

  return { hasConfusion: false, hasSuccess: false };
}

// ── SYSTEM PROMPT ──
function buildSystemPrompt(profile, conversationHistory, todayTask, studyPlan)  {
  const total = profile.correctAnswers + profile.wrongAnswers;
  const accuracy = total > 0 ? Math.round((profile.correctAnswers / total) * 100) : 0;
  const weakTopicsList = profile.weakTopics.slice(-5).join(', ') || 'none identified';

  const levelInstructions = {
    beginner: `
- Explain as simply as possible, use everyday analogies
- Break complex concepts into small parts
- Give lots of examples
- If the student doesn't understand — explain from a different angle
- After each explanation, ask one simple check question
- Use emojis for clarity`,

    intermediate: `
- Explain clearly and in a structured way
- Give medium-difficulty examples
- Connect new material to what the student already knows
- Ask questions that require thinking
- Give hints occasionally when the student struggles`,

    advanced: `
- Talk as an equal, use professional terminology
- Give complex tasks and case studies
- Minimal hints — let them think independently
- Ask questions requiring deep analysis and critical thinking
- Point out nuances and exceptions to rules`,
  };

  const recentTopics = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => m.content.slice(0, 50))
    .join(' | ');

  return `You are a personal AI tutor for EduAI. You adapt to each student individually.

═══════════════════════════════
STUDENT PROFILE:
- ID: ${profile.userId}
- Level: ${profile.level.toUpperCase()}
- Answer accuracy: ${accuracy}%
- Correct: ${profile.correctAnswers} | Wrong: ${profile.wrongAnswers}
- Weak topics: ${weakTopicsList}
- Sessions completed: ${profile.totalSessions}
═══════════════════════════════

YOUR STRATEGY (level: ${profile.level}):
${levelInstructions[profile.level]}

ADAPTATION RULES:
1. If the student says they don't understand → simplify, use a different approach
2. If the student answers correctly → gradually increase difficulty
3. If the same mistake repeats → explain from scratch in a different way
4. Identify the topic and remember the student's weak spots
5. NEVER ask multiple questions at once — only one at a time

RESPONSE FORMAT:
- Be specific and to the point
- Structure long answers clearly
- Use examples
- End each explanation with ONE check question
- Reply in the language the student uses (English, Russian, or Kazakh)
- Be friendly and encouraging

RECENT TOPICS: ${recentTopics || 'start of conversation'}

${todayTask ? `
═══════════════════════════════
📅 TODAY'S STUDY PLAN TASK:
- Subject: ${todayTask.subject}
- Topic: ${todayTask.topic}
- Subtopics: ${todayTask.subtopics?.join(', ') || ''}
- Duration: ${todayTask.durationMinutes} minutes
- Type: ${todayTask.taskType}

IMPORTANT: If the student says anything like "let's start", "ready", "begin", "go", "continue" or asks about their plan — automatically start teaching TODAY'S TASK above. Don't wait for them to specify the topic. When you feel the student has understood the topic well, tell them: "✅ Great job! I'm marking '${todayTask.topic}' as complete. Type /next to move to the next topic."
═══════════════════════════════` : ''}

${studyPlan ? `FULL PLAN OVERVIEW: ${studyPlan.plans.map(p => `${p.subject}: ${p.completedTopics}/${p.totalTopics} done`).join(', ')}` : ''}`;
}

// ── DETECT TOPIC ──
function detectTopic(message) {
  const topics = {
    'math': ['math', 'algebra', 'geometry', 'equation', 'function', 'integral', 'derivative', 'matrix', 'математик', 'алгебр', 'геометр', 'уравнени'],
    'physics': ['physics', 'mechanics', 'electric', 'magnetic', 'thermodynamics', 'quantum', 'force', 'energy', 'velocity', 'физик', 'механик', 'электр'],
    'chemistry': ['chemistry', 'element', 'reaction', 'molecule', 'atom', 'substance', 'acid', 'base', 'хими', 'элемент', 'реакци', 'молекул'],
    'biology': ['biology', 'cell', 'organism', 'evolution', 'genetics', 'photosynthesis', 'dna', 'rna', 'биологи', 'клетк', 'организм'],
    'history': ['history', 'war', 'revolution', 'empire', 'state', 'politics', 'истори', 'война', 'революци'],
    'english': ['english', 'grammar', 'vocabulary', 'tense', 'verb', 'noun', 'английск', 'язык'],
    'programming': ['code', 'program', 'algorithm', 'function', 'array', 'python', 'javascript', 'java', 'код', 'программ', 'алгоритм'],
  };

  const msgLower = message.toLowerCase();
  for (const [topic, keywords] of Object.entries(topics)) {
    if (keywords.some(kw => msgLower.includes(kw))) return topic;
  }
  return null;
}

// ── RECALCULATE LEVEL ──
function recalculateLevel(profile) {
  const total = profile.correctAnswers + profile.wrongAnswers;
  if (total < 5) return profile.level;
  const accuracy = profile.correctAnswers / total;
  if (accuracy >= 0.8 && total >= 10) return 'advanced';
  if (accuracy >= 0.6) return 'intermediate';
  return 'beginner';
}

// ══════════════════════════════════════════════
// ── CHAT ENDPOINT ──
// ══════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  try {
    const { message, studentId, conversationHistory = [], imageBase64, imageType } = req.body;

    if (!message || !studentId) {
      return res.status(400).json({ error: 'message and studentId are required' });
    }

    const profile = await getStudentProfile(studentId);
    // Читаем план студента
let studyPlan = null;
let todayTask = null;
try {
  const sheets = await getSheets();
  const planResult = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'StudyPlans!A:D',
  });
  const planRows = planResult.data.values || [];
  const userPlanRow = planRows.filter(r => r[0] === studentId).pop();
  if (userPlanRow) {
    studyPlan = JSON.parse(userPlanRow[1]);
    // Находим задачу на сегодня
    const today = new Date().toISOString().split('T')[0];
    studyPlan.plans.forEach(p => {
      const task = p.dailySchedule.find(d => !d.completed && d.date === today);
      if (task) todayTask = { subject: p.subject, ...task };
    });
    // Если нет задачи на сегодня — берём первую невыполненную
    if (!todayTask) {
      studyPlan.plans.forEach(p => {
        if (!todayTask) {
          const task = p.dailySchedule.find(d => !d.completed);
          if (task) todayTask = { subject: p.subject, ...task };
        }
      });
    }
  }
} catch(e) {
  console.log('Plan read error (non-critical):', e.message);
}
    profile.totalSessions++;

    const { hasConfusion, hasSuccess } = analyzeConversation(conversationHistory);

    if (hasSuccess) {
      profile.correctAnswers++;
    } else if (hasConfusion) {
      profile.wrongAnswers++;
      const topic = detectTopic(message);
      if (topic && !profile.weakTopics.includes(topic)) {
        profile.weakTopics.push(topic);
      }
    }

    profile.level = recalculateLevel(profile);

    const systemPrompt = buildSystemPrompt(profile, conversationHistory, todayTask, studyPlan);

    const claudeMessages = conversationHistory
      .slice(-20)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    // Support image uploads
    if (imageBase64 && imageType) {
      claudeMessages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
          { type: 'text', text: message || 'Please help me with this image.' }
        ]
      });
    } else {
      claudeMessages.push({ role: 'user', content: message });
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: claudeMessages,
    });

    const aiResponse = response.content[0].text;
    // Автоматически отмечаем тему если AI сказал что она выполнена
if (todayTask && aiResponse.includes("marking") && aiResponse.includes("complete")) {
  try {
    const sheets = await getSheets();
    const planResult = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: 'StudyPlans!A:D',
    });
    const planRows = planResult.data.values || [];
    const rowIndex = planRows.map(r => r[0]).lastIndexOf(studentId);
    if (rowIndex !== -1) {
      const plan = JSON.parse(planRows[rowIndex][1]);
      const subjectPlan = plan.plans.find(p => p.subject === todayTask.subject);
      if (subjectPlan) {
        const dayPlan = subjectPlan.dailySchedule.find(d => d.day === todayTask.day);
        if (dayPlan) {
          dayPlan.completed = true;
          subjectPlan.completedTopics = subjectPlan.dailySchedule.filter(d => d.completed).length;
        }
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `StudyPlans!B${rowIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [[JSON.stringify(plan)]] }
      });
      console.log('✅ Auto-completed topic:', todayTask.topic);
    }
  } catch(e) { console.log('Auto-complete error:', e.message); }
}

    const topicFromMsg = detectTopic(message);
    if (topicFromMsg && hasConfusion && !profile.weakTopics.includes(topicFromMsg)) {
      profile.weakTopics.push(topicFromMsg);
    }

    await saveStudentProfile(profile);

// Синхронизируем в Firestore для Progress панели
try {
  const db = admin.firestore();
  await db.collection('users').doc(studentId).update({
    level: profile.level,
    correctAnswers: profile.correctAnswers,
    wrongAnswers: profile.wrongAnswers,
    weakTopics: profile.weakTopics,
    totalSessions: profile.totalSessions,
  });
} catch(e) { console.log('Firestore sync error:', e.message); }

    const total = profile.correctAnswers + profile.wrongAnswers;
    const accuracy = total > 0 ? Math.round((profile.correctAnswers / total) * 100) : 0;

    res.json({
      response: aiResponse,
      profile: {
        level: profile.level,
        accuracy,
        correctAnswers: profile.correctAnswers,
        wrongAnswers: profile.wrongAnswers,
        weakTopics: profile.weakTopics.slice(-5),
        totalSessions: profile.totalSessions,
      },
    });

  } catch (error) {
    console.error('Error /api/chat:', error.message);
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// ══════════════════════════════════════════════
// ── PROFILE ENDPOINT (for n8n) ──
// ══════════════════════════════════════════════
app.get('/api/profile/:studentId', async (req, res) => {
  try {
    const profile = await getStudentProfile(req.params.studentId);
    const total = profile.correctAnswers + profile.wrongAnswers;
    res.json({
      userId: profile.userId,
      level: profile.level,
      correctAnswers: profile.correctAnswers,
      wrongAnswers: profile.wrongAnswers,
      accuracy: total > 0 ? Math.round((profile.correctAnswers / total) * 100) : 0,
      weakTopics: profile.weakTopics,
      totalSessions: profile.totalSessions,
      lastActive: profile.lastActive,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── ALL PROFILES (for n8n) ──
app.get('/api/profiles', async (req, res) => {
  try {
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'StudyPlans!A:D',
    });
    const rows = result.data.values || [];
    const userIds = [...new Set(rows.map(r => r[0]).filter(Boolean))];

    const db = admin.firestore();
    const profiles = await Promise.all(userIds.map(async (userId) => {
      try {
        const snap = await db.collection('users').doc(userId).get();
        const telegramChatId = snap.exists ? (snap.data().telegramChatId || '') : '';
        return { userId, telegramChatId };
      } catch(e) {
        return { userId, telegramChatId: '' };
      }
    }));

    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── HEALTH CHECK ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════
// ── TELEGRAM BOT ──
// ══════════════════════════════════════════════
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'student';
  bot.sendMessage(chatId,
    `👋 Hey ${name}!\n\nI'm the EduAI bot. I'll help you prepare for your exams.\n\n` +
    `📋 *Commands:*\n` +
    `/myid — get your Chat ID\n` +
    `/stats — your progress\n` +
    `/plan — get an AI study plan\n` +
    `/pomodoro — start a 25-min timer\n` +
    `/help — help`,
    { parse_mode: 'Markdown' }
  );
});

// /myid
bot.onText(/\/myid/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `🆔 Your Telegram Chat ID:\n\n\`${chatId}\`\n\n` +
    `Copy this number and paste it in *Settings → Notifications* on the EduAI website.`,
    { parse_mode: 'Markdown' }
  );
});

// /stats
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '⏳ Loading your statistics...');

  try {
    // Находим userId по telegramChatId в Firestore
    const db = admin.firestore();
    const usersSnap = await db.collection('users').get();
    let userId = null;
    
    usersSnap.forEach(doc => {
      if (String(doc.data().telegramChatId) === String(chatId)) {
        userId = doc.id;
      }
    });

    if (!userId) {
      bot.sendMessage(chatId, '❌ Account not linked.\n\nGo to EduAI → Settings → Notifications and connect your Telegram ID.');
      return;
    }

    const profile = await getStudentProfile(userId);
    const total = profile.correctAnswers + profile.wrongAnswers;
    const acc = total > 0 ? Math.round((profile.correctAnswers / total) * 100) : 0;

    // Берём план если есть
    const planSnap = await db.collection('users').doc(userId).collection('studyPlans').doc('current').get();
    let planText = '';
    if (planSnap.exists) {
      const plans = planSnap.data().plan.plans || [];
      planText = '\n\n📅 *Study Plans:*\n';
      plans.forEach(p => {
        const pct = p.totalTopics > 0 ? Math.round((p.completedTopics / p.totalTopics) * 100) : 0;
        const today = new Date(); today.setHours(0,0,0,0);
        const examParts = p.examDate.split('-');
        const exam = new Date(parseInt(examParts[0]), parseInt(examParts[1])-1, parseInt(examParts[2]));
        const daysLeft = Math.ceil((exam - today) / (1000*60*60*24));
        planText += `📚 *${p.subject}* — ${daysLeft} days left\n`;
        planText += `Progress: ${p.completedTopics}/${p.totalTopics} topics (${pct}%)\n`;
      });
    }

    bot.sendMessage(chatId,
      `📊 *Your EduAI Stats*\n\n` +
      `📈 Level: *${profile.level}*\n` +
      `✅ Correct: ${profile.correctAnswers} | ❌ Wrong: ${profile.wrongAnswers}\n` +
      `🎯 Accuracy: ${acc}%\n` +
      `📖 Sessions: ${profile.totalSessions}` +
      planText,
      { parse_mode: 'Markdown' }
    );
  } catch(e) {
    console.error(e);
    bot.sendMessage(chatId, '❌ Error loading statistics.');
  }
});

// /plan
bot.onText(/\/plan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🤔 Creating your personalized study plan...');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Create a short study plan for today for a student preparing for exams.
        Format: 3-4 blocks of 25 minutes (pomodoro).
        Keep it short, motivating, in English.
        Use emojis. Maximum 200 words.`
      }]
    });

    const plan = response.content[0].text;
    bot.sendMessage(chatId, `📅 *Your plan for today:*\n\n${plan}`, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, '❌ Failed to create a plan. Please try again later.');
  }
});

// /pomodoro
bot.onText(/\/pomodoro/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `⏱ *Pomodoro timer started!*\n\n` +
    `🍅 Work for 25 minutes without distractions\n` +
    `I'll remind you when the time is up!\n\n` +
    `_Focus. You've got this!_ 💪`,
    { parse_mode: 'Markdown' }
  );

  setTimeout(() => {
    bot.sendMessage(chatId,
      `✅ *25 minutes done!*\n\n` +
      `Great work! Take a 5-minute break 🧘\n\n` +
      `Type /pomodoro to start the next round`,
      { parse_mode: 'Markdown' }
    );
  }, 25 * 60 * 1000);
});

// /help
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📚 *EduAI Bot — Help*\n\n` +
    `/start — get started\n` +
    `/myid — get your Chat ID for the website\n` +
    `/stats — view your study statistics\n` +
    `/plan — AI creates a daily study plan\n` +
    `/pomodoro — 25-minute focus timer\n` +
    `/help — this message\n\n` +
    `💻 Study at: http://localhost:3000`,
    { parse_mode: 'Markdown' }
  );
});

console.log('🤖 Telegram bot started');

// ══════════════════════════════════════════════
// ── STUDY PLAN ENGINE ──
// ══════════════════════════════════════════════
app.post('/api/study-plan', async (req, res) => {
  try {
    const { studentId, exams, totalDays } = req.body;
    // exams = [{ subject: "Calculus", date: "2026-05-10", topics: ["limits","derivatives","integrals"] }]

    if (!studentId || !exams || !exams.length) {
      return res.status(400).json({ error: 'studentId and exams required' });
    }

    const profile = await getStudentProfile(studentId);

    // Строим промпт для Claude
    const todayStr = new Date().toISOString().split('T')[0];
const examsText = exams.map(e => {
  const daysLeft = Math.ceil((new Date(e.date) - new Date()) / (1000*60*60*24));
  return `- ${e.subject}: exam on ${e.date} (${daysLeft} days from today ${todayStr}), topics: ${e.topics.join(', ')}`;
}).join('\n');

    const planPrompt = `You are an expert study planner. Create a detailed day-by-day study schedule.

Student level: ${profile.level}
Weak topics: ${profile.weakTopics.join(', ') || 'none identified yet'}

Exams:
${examsText}
Today's date is: ${todayStr}
Create a JSON study plan. Rules:
- Prioritize by urgency (closer exam = higher priority)
- Split topics across available days
- Weak topics get more time
- Include daily goals (2-3 hours max per day)
- Add review days before each exam

Return ONLY valid JSON in this exact format:
{
  "plans": [
    {
      "subject": "Calculus",
      "examDate": "2026-05-10",
      "daysLeft": 14,
      "priority": "HIGH",
      "color": "#f85149",
      "dailySchedule": [
        {
          "day": 1,
          "date": "2026-04-30",
          "topic": "Limits — introduction",
          "subtopics": ["definition", "one-sided limits", "limit laws"],
          "durationMinutes": 90,
          "taskType": "study",
          "completed": false
        }
      ],
      "totalTopics": 10,
      "completedTopics": 0
    }
  ],
  "overallStrategy": "Focus on Calculus first (closest exam). Switch to Physics after May 5."
}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: planPrompt }]
    });

    let planData;
    try {
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      planData = JSON.parse(jsonMatch[0]);
    } catch(e) {
      return res.status(500).json({ error: 'Failed to parse AI plan' });
    }

    // Сохраняем в Google Sheets — новый лист "StudyPlans"
    try {
      const sheets = await getSheets();
      const planRow = [[
        studentId,
        JSON.stringify(planData),
        new Date().toISOString(),
        'active'
      ]];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'StudyPlans!A:D',
        valueInputOption: 'RAW',
        resource: { values: planRow }
      });
    } catch(e) {
      console.log('Sheets save error (non-critical):', e.message);
    }

    res.json({ success: true, plan: planData, studentId });

  } catch (error) {
    console.error('Study plan error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── GET STUDY PLAN ──
app.get('/api/study-plan/:studentId', async (req, res) => {
  try {
    const db = admin.firestore();
    const snap = await db.collection('users').doc(req.params.studentId).collection('studyPlans').doc('current').get();
    
    if (!snap.exists) {
      return res.json({ plan: null, telegramChatId: '' });
    }
    
    // Берём telegramChatId из users документа
    const userSnap = await db.collection('users').doc(req.params.studentId).get();
    const telegramChatId = userSnap.exists ? (userSnap.data().telegramChatId || '') : '';
    
    res.json({ 
      plan: snap.data().plan,
      telegramChatId
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MARK TOPIC COMPLETE ──
app.post('/api/study-plan/complete', async (req, res) => {
  try {
    const { studentId, subject, day } = req.body;
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'StudyPlans!A:D',
    });
    const rows = result.data.values || [];
    const rowIndex = rows.map(r => r[0]).lastIndexOf(studentId);
    
    if (rowIndex === -1) return res.status(404).json({ error: 'Plan not found' });
    
    const plan = JSON.parse(rows[rowIndex][1]);
    const subjectPlan = plan.plans.find(p => p.subject === subject);
    if (subjectPlan) {
      const dayPlan = subjectPlan.dailySchedule.find(d => d.day === day);
      if (dayPlan) {
        dayPlan.completed = true;
        subjectPlan.completedTopics = subjectPlan.dailySchedule.filter(d => d.completed).length;
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `StudyPlans!B${rowIndex + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [[JSON.stringify(plan)]] }
    });

    res.json({ success: true, plan });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ EduAI Backend started at http://localhost:${PORT}`);
});