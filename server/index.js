require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
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
  // Ищем паттерн: AI задал вопрос с вариантами → пользователь ответил
  const recent = messages.slice(-4); // последние 4 сообщения
  
  const lastAI = [...recent].reverse().find(m => m.role === 'assistant');
  const lastUser = [...recent].reverse().find(m => m.role === 'user');
  
  if (!lastAI || !lastUser) return { hasConfusion: false, hasSuccess: false };

  const aiText = lastAI.content.toLowerCase();
  const userText = (lastUser.content || '').toLowerCase();

  // AI задавал тестовый вопрос? (ищем маркеры вопроса с вариантами)
  const aiAskedQuestion = 
    (aiText.includes('a)') || aiText.includes('а)') || aiText.includes('option a') || aiText.includes('вариант')) &&
    (aiText.includes('b)') || aiText.includes('б)') || aiText.includes('option b')) &&
    (aiText.includes('?'));

  if (!aiAskedQuestion) {
    // AI не задавал тест — просто смотрим на явные признаки
    const confusionWords = ["don't understand", "not clear", "confused", "lost", "не понимаю", "непонятно", "не знаю", "помогите"];
    const hasConfusion = confusionWords.some(w => userText.includes(w));
    return { hasConfusion, hasSuccess: false };
  }

  // AI задавал тест — оцениваем ответ пользователя
  // Ищем правильный ответ в тексте AI: паттерн "✓ A)" или "correct: b" или "правильный ответ — б"
  const correctMatch = 
    lastAI.content.match(/correct[:\s]+([a-dа-г])\)?/i) ||
    lastAI.content.match(/answer[:\s]+([a-dа-г])\)?/i) ||
    lastAI.content.match(/правильн\w+[:\s—-]+([а-гa-d])\)?/i) ||
    lastAI.content.match(/✓\s*([a-dа-г])\)?/i);

  // Если AI ещё не раскрыл ответ — оцениваем по следующему ответу AI
  // Смотрим есть ли в следующем ответе AI "correct!" / "правильно!"
  const nextAI = messages[messages.length - 1];
  if (nextAI && nextAI.role === 'assistant') {
    const nextText = nextAI.content.toLowerCase();
    const confirmsCorrect = ['correct!', 'right!', 'exactly!', 'perfect!', 'правильно!', 'верно!', 'отлично!', '✅'].some(w => nextText.includes(w));
    const confirmsWrong = ['incorrect', 'wrong', 'not quite', 'неправильно', 'неверно', 'к сожалению', 'нет,'].some(w => nextText.includes(w));
    if (confirmsCorrect) return { hasConfusion: false, hasSuccess: true };
    if (confirmsWrong) return { hasConfusion: true, hasSuccess: false };
  }

  // Явный отказ / непонимание
  const giveUp = ["i don't know", "no idea", "idk", "skip", "не знаю", "пропусти", "понятия не имею", "я тупой", "не понял"];
  if (giveUp.some(w => userText.includes(w))) return { hasConfusion: true, hasSuccess: false };

  return { hasConfusion: false, hasSuccess: false };
}
function buildSystemPrompt(profile, conversationHistory, todayTask, studyPlan) {
  const total = profile.correctAnswers + profile.wrongAnswers;
  const accuracy = total > 0 ? Math.round((profile.correctAnswers / total) * 100) : 0;
  const weakTopicsList = profile.weakTopics.slice(-5).join(', ') || 'none identified';

  const recentTopics = conversationHistory
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => m.content.slice(0, 60))
    .join(' | ');

  const levelInstructions = {
    beginner: `
- Use simple everyday analogies before introducing formal terms
- Break every concept into the smallest possible steps
- Never assume prior knowledge — always build from scratch
- After each new idea, give a concrete example immediately
- Praise effort, not just correct answers`,
    intermediate: `
- Introduce proper terminology alongside intuitive explanations
- Connect new concepts to things the student already knows
- Challenge with "what would happen if..." style questions
- Provide hints when stuck, but let them work through it first
- Point out common mistakes for this topic proactively`,
    advanced: `
- Use precise academic language and notation
- Discuss edge cases, exceptions, and deeper implications
- Assign open-ended problems that require synthesis
- Push back gently if an answer is incomplete or imprecise
- Reference connections to adjacent fields when relevant`,
  };

  const quizInstruction = total < 3
    ? `ASSESSMENT: Student is new — focus on building confidence. Ask simple comprehension checks, not trick questions.`
    : accuracy >= 80
    ? `ASSESSMENT: Student is performing well (${accuracy}% accuracy). Push difficulty up — ask application and analysis questions.`
    : accuracy >= 60
    ? `ASSESSMENT: Student is developing (${accuracy}% accuracy). Mix recall and application questions. Give partial credit in feedback.`
    : `ASSESSMENT: Student is struggling (${accuracy}% accuracy). Prioritise understanding over speed. Diagnose misconceptions before moving on.`;

  return `You are an expert AI tutor inside EduAI — an adaptive learning platform. Your job is to teach, assess, and personalise every interaction based on the student's actual performance data.

━━━ STUDENT PROFILE ━━━
Level: ${profile.level.toUpperCase()} | Accuracy: ${accuracy}% (${profile.correctAnswers} correct, ${profile.wrongAnswers} wrong) | Sessions: ${profile.totalSessions}
Weak areas: ${weakTopicsList}
Recent messages: ${recentTopics || 'session just started'}

━━━ TEACHING APPROACH (${profile.level}) ━━━
${levelInstructions[profile.level]}

━━━ COMMUNICATION STYLE ━━━
- Be natural and direct — like a knowledgeable friend, not a textbook
- Never robotically confirm what the student just said ("You chose A, which means...")
- Never offer numbered menu options for trivial decisions ("1️⃣ Yes 2️⃣ No")
- If the student names a topic, start teaching it immediately — no permission needed
- Keep responses focused; only go long when the concept genuinely demands it
- Match the student's language (English, Russian, or Kazakh) automatically
- One idea at a time — never stack multiple questions in one message

━━━ ASSESSMENT STRATEGY ━━━
${quizInstruction}

Quiz format rules:
- Ask a multiple-choice question (A / B / C / D) only after you've explained a real concept (not after greetings, topic choices, or small talk)
- Make the question test understanding, not memorisation
- When the student answers: open with ✅ Correct! or ❌ Not quite — then in 1–2 sentences explain why, then continue the lesson
- If the student says "I don't know" / "не знаю" / "я тупой" or similar — don't quiz further; diagnose the confusion and re-explain from a different angle
- Never repeat the same question twice

━━━ RESPONSE FORMAT ━━━
Structure every teaching response like this:

1. HOOK (1 sentence) — a relatable analogy or real-world connection to grab attention
2. CORE EXPLANATION — the actual concept, broken into short paragraphs with line breaks
   • Use bullet points for lists of properties or steps
   • Use emojis as visual anchors (📌 for key ideas, 💡 for insights, ⚠️ for common mistakes, 🔢 for math)
   • Bold key terms using **term**
3. EXAMPLE — a concrete mini-example right after the explanation, not separated from it
4. QUIZ QUESTION (if appropriate) — formatted exactly like this:

---
**Quick check:**
[Question text]

**A)** option
**B)** option  
**C)** option
**D)** option
---

When giving feedback on a quiz answer, format it like this:
✅ **Correct!** [1 sentence why] → [continue lesson or go deeper]
❌ **Not quite.** The right answer is [X] — [1-2 sentences explaining the misconception clearly]

General formatting rules:
- Never write walls of text — max 3-4 sentences per paragraph before a line break
- Never use numbered lists for conversational choices ("1. Do this 2. Do that")
- The response should feel like a well-designed study card, not a chat message
- If the student asks to start a topic — open with the hook immediately, no preamble
,'

━━━ ADAPTATION RULES ━━━
- Correct answer → acknowledge briefly, then increase depth slightly
- Wrong answer → identify the specific misconception, correct it gently, give a new simpler example
- Repeated confusion on the same point → completely change your explanation strategy (different analogy, visual description, or real-world context)
- Frustration detected → reduce pressure, validate the difficulty, rebuild confidence before continuing
${todayTask ? `
━━━ TODAY'S SCHEDULED TASK ━━━
Subject: ${todayTask.subject} | Topic: ${todayTask.topic}
Subtopics: ${todayTask.subtopics?.join(', ') || 'as needed'} | Duration: ${todayTask.durationMinutes} min

IMPORTANT: The study plan is a SUGGESTION, not a prison. If the student asks about ANY topic — teach it immediately without mentioning the plan. Only bring up the plan if the student explicitly asks "what should I study today?" or "what's my plan?". Never redirect the student back to the plan mid-conversation.
When you are confident the student understood the core material, say exactly: "✅ Great work! I'm marking '${todayTask.topic}' as complete."
━━━ FULL PLAN CONTEXT ━━━
${studyPlan.plans.map(p => `${p.subject}: ${p.completedTopics}/${p.totalTopics} topics done`).join(' | ')}` : ''}`;
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

    if (!studentId) {
  return res.status(400).json({ error: 'studentId is required' });
}
if (!message && !imageBase64) {
  return res.status(400).json({ error: 'message or image is required' });
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

    const { hasConfusion, hasSuccess } = analyzeConversation([...conversationHistory, { role: 'user', content: message }]);

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
  if (imageType === 'application/pdf') {
    // PDF — отправляем как документ
    claudeMessages.push({
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: imageBase64
          }
        },
        { type: 'text', text: message || 'Please read this PDF and help me understand it. Answer any questions about its content.' }
      ]
    });
  } else {
    // Картинка
    claudeMessages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
        { type: 'text', text: message || 'Please help me with this image.' }
      ]
    });
  }
} else {
  claudeMessages.push({ role: 'user', content: message || '' });
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
  bot.sendMessage(msg.chat.id,
    `📚 *EduAI Bot — Help*\n\n` +
    `/start — get started\n` +
    `/myid — get your Chat ID for the website\n` +
    `/stats — view your study statistics\n` +
    `/next — show next study task\n` +
    `/plan — AI creates a daily study plan\n` +
    `/pomodoro — 25-minute focus timer\n` +
    `/help — this message\n\n` +
    `💻 Study at: http://localhost:3000`,
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
        const rTotal = p.dailySchedule ? p.dailySchedule.length : p.totalTopics;
const rCompleted = p.dailySchedule ? p.dailySchedule.filter(d => d.completed).length : p.completedTopics;
planText += `Progress: ${rCompleted}/${rTotal} topics (${pct}%)\n`;
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
// /plan
bot.onText(/\/plan/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🤔 Loading your study plan...');

  try {
    // Находим userId по chatId
    const db = admin.firestore();
    const usersSnap = await db.collection('users').get();
    let userId = null;
    usersSnap.forEach(doc => {
      if (String(doc.data().telegramChatId) === String(chatId)) userId = doc.id;
    });

    if (!userId) {
      bot.sendMessage(chatId, '❌ Account not linked.\n\nGo to EduAI → Settings → Notifications and connect your Telegram ID.');
      return;
    }

    // Берём план из Firestore
    const planSnap = await db.collection('users').doc(userId).collection('studyPlans').doc('current').get();
    if (!planSnap.exists) {
      bot.sendMessage(chatId, '📅 No study plan found. Create one at EduAI website first!');
      return;
    }

    const plan = planSnap.data().plan;
    const today = new Date().toISOString().split('T')[0];

    // Собираем все невыполненные темы
    let allTasks = [];
    plan.plans.forEach(p => {
      const examDate = new Date(p.examDate);
      const daysLeft = Math.ceil((examDate - new Date()) / (1000*60*60*24));
      const pending = p.dailySchedule.filter(d => !d.completed);
      if (pending.length > 0) {
        allTasks.push({
          subject: p.subject,
          daysLeft,
          completedTopics: p.completedTopics,
          totalTopics: p.totalTopics,
          topics: pending.slice(0, 3).map(t => ({
            topic: t.topic,
            subtopics: t.subtopics,
            durationMinutes: t.durationMinutes
          }))
        });
      }
    });

    allTasks.sort((a, b) => a.daysLeft - b.daysLeft);

    if (!allTasks.length) {
      bot.sendMessage(chatId, '🎉 All topics completed! You are ready for your exams!');
      return;
    }

    // Отправляем в Claude чтобы сделал красивый план
    const tasksText = allTasks.map(t =>
      `${t.subject} (${t.daysLeft} days until exam, ${t.completedTopics}/${t.totalTopics} done):\n` +
      t.topics.map(tp => `  - ${tp.topic} (${tp.durationMinutes} min): ${tp.subtopics?.join(', ')}`).join('\n')
    ).join('\n\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Create a beautiful, motivating full day study plan based on these REAL pending topics:

${tasksText}

Rules:
- Use the ACTUAL topics listed above, not generic ones
- Show time blocks (e.g. 9:00-10:30 AM)
- Add short breaks
- Use emojis 📚🧠⏰☕💪
- End with a motivating message
- Max 350 words
- Format nicely for Telegram`
      }]
    });

    const planMessage = response.content[0].text;
    bot.sendMessage(chatId, `🌅 *Good morning! Full day study plan:*\n\n${planMessage}`, { parse_mode: 'Markdown' });

  } catch (e) {
    console.error('/plan error:', e.message);
    bot.sendMessage(chatId, '❌ Error loading plan: ' + e.message);
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
// /next
bot.onText(/\/next/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const db = admin.firestore();
    const usersSnap = await db.collection('users').get();
    let userId = null;
    usersSnap.forEach(doc => {
      if (String(doc.data().telegramChatId) === String(chatId)) userId = doc.id;
    });

    if (!userId) {
      bot.sendMessage(chatId, '❌ Account not linked. Go to EduAI → Settings → Notifications.');
      return;
    }

    const planSnap = await db.collection('users').doc(userId).collection('studyPlans').doc('current').get();
    if (!planSnap.exists) {
      bot.sendMessage(chatId, '📅 No study plan found. Create one at EduAI website!');
      return;
    }

    const plans = planSnap.data().plan.plans || [];
    let nextTask = null, nextSubject = null;
    plans.forEach(p => {
      if (!nextTask) {
        const t = p.dailySchedule.find(d => !d.completed);
        if (t) { nextTask = t; nextSubject = p.subject; }
      }
    });

    if (!nextTask) {
      bot.sendMessage(chatId, '🎉 All topics completed! You are ready for your exams!');
      return;
    }

    bot.sendMessage(chatId,
      `⏭ *Next Task*\n\n` +
      `📚 *${nextSubject}*\n` +
      `📖 ${nextTask.topic}\n` +
      `🔹 ${nextTask.subtopics?.join(', ') || ''}\n` +
      `⏱ ${nextTask.durationMinutes} min · ${nextTask.taskType}\n\n` +
      `_Go to EduAI to start studying!_`,
      { parse_mode: 'Markdown' }
    );
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
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

    // Пересчитываем totalTopics правильно
    planData.plans = planData.plans.map(p => ({
      ...p,
      totalTopics: p.dailySchedule.length,
      completedTopics: p.dailySchedule.filter(d => d.completed).length
    }));

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