const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 18790;
const OPENCLAW_DIR = process.env.HOME + '/.openclaw';
const WORKSPACE_DIR = OPENCLAW_DIR + '/workspace';

// OpenWeatherMap Token - 需要用户配置
const WEATHER_TOKEN = process.env.OPENWEATHERMAP_TOKEN || '';

// CORS and JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Execute shell command
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// Helper: Read file safely
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// API: Version
app.get('/api/version', (req, res) => {
  const versionFile = WORKSPACE_DIR + '/openclaw-dashboard/version.txt';
  const version = readFile(versionFile) || '1.0.0';
  res.json({ version: version.trim() });
});

// API: OpenClaw Status
app.get('/api/status', async (req, res) => {
  try {
    const config = JSON.parse(readFile(OPENCLAW_DIR + '/openclaw.json') || '{}');
    const jobs = JSON.parse(readFile(OPENCLAW_DIR + '/jobs.json') || '{}');
    
    // Check if gateway is running - try to connect to the port
    let gatewayStatus = 'stopped';
    try {
      const result = await execAsync('curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/health');
      gatewayStatus = result.trim() === '200' ? 'running' : 'stopped';
    } catch {
      gatewayStatus = 'stopped';
    }

    // Check for new version
    let updateInfo = { available: false, version: '' };
    try {
      const updateCheck = JSON.parse(readFile(OPENCLAW_DIR + '/update-check.json') || '{}');
      if (updateCheck.latestVersion && updateCheck.currentVersion) {
        updateInfo = {
          available: updateCheck.latestVersion !== updateCheck.currentVersion,
          version: updateCheck.latestVersion
        };
      }
    } catch {}

    const cronList = jobs.jobs || [];

    res.json({
      version: config.meta?.lastTouchedVersion || 'unknown',
      gatewayPort: config.gateway?.port || 18789,
      gatewayStatus,
      lastTouched: config.meta?.lastTouchedAt,
      models: config.models?.providers || {},
      defaultModel: config.agents?.defaults?.model || {},
      channels: config.channels || {},
      cronJobs: cronList.length,
      updateInfo
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Model Configuration
app.get('/api/models', (req, res) => {
  try {
    const config = JSON.parse(readFile(OPENCLAW_DIR + '/openclaw.json') || '{}');
    res.json({
      providers: config.models?.providers || {},
      defaults: config.agents?.defaults?.model || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Switch Model
app.post('/api/models/switch', express.json(), async (req, res) => {
  try {
    const { primary, fallbacks } = req.body;
    const configPath = OPENCLAW_DIR + '/openclaw.json';
    const config = JSON.parse(readFile(configPath) || '{}');
    
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    
    config.agents.defaults.model = { primary, fallbacks: fallbacks || [] };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    res.json({ success: true, message: `Model switched to ${primary}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Skills List
app.get('/api/skills', (req, res) => {
  try {
    // 读取多个可能的skills目录
    const possibleDirs = [
      OPENCLAW_DIR + '/skills',
      path.join(OPENCLAW_DIR, 'workspace/skills'),
      path.join(OPENCLAW_DIR, '../.openclaw/skills')
    ];
    
    const skills = [];
    
    for (const skillsDir of possibleDirs) {
      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillPath = path.join(skillsDir, entry.name);
            const skillFile = path.join(skillPath, 'SKILL.md');
            let description = '';
            if (fs.existsSync(skillFile)) {
              const content = fs.readFileSync(skillFile, 'utf8');
              const descMatch = content.match(/^#\s+(.+)/m);
              description = descMatch ? descMatch[1] : '';
            }
            
            // 避免重复
            if (!skills.find(s => s.name === entry.name)) {
              skills.push({
                name: entry.name,
                path: skillPath,
                description
              });
            }
          }
        }
      }
    }
    
    res.json(skills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Available Skills (from workspace/skills)
app.get('/api/skills/available', (req, res) => {
  try {
    const skillsDir = WORKSPACE_DIR + '/skills';
    const skills = [];
    
    if (fs.existsSync(skillsDir)) {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(skillsDir, entry.name);
          const skillFile = path.join(skillPath, 'SKILL.md');
          let description = '';
          if (fs.existsSync(skillFile)) {
            const content = fs.readFileSync(skillFile, 'utf8');
            const descMatch = content.match(/^#\s+(.+)/m);
            description = descMatch ? descMatch[1] : '';
          }
          skills.push({
            name: entry.name,
            path: skillPath,
            description: description
          });
        }
      }
    }
    
    res.json(skills);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Install Skill
app.post('/api/skills/install', express.json(), async (req, res) => {
  const { slug } = req.body;
  if (!slug) {
    return res.status(400).json({ error: '缺少 slug' });
  }
  
  try {
    // Use npx clawhub to install
    const cmd = `cd ${WORKSPACE_DIR} && npx clawhub install ${slug} 2>&1`;
    const output = await execAsync(cmd);
    
    res.json({ success: true, message: '安装完成', output });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Cron Jobs with detailed info
app.get('/api/cron', (req, res) => {
  try {
    const jobs = JSON.parse(readFile(OPENCLAW_DIR + '/jobs.json') || '{}');
    const jobList = (jobs.jobs || []).map(job => {
      // 解析schedule对象
      let scheduleExpr = '--';
      let nextRun = '--';
      
      if (job.schedule) {
        if (typeof job.schedule === 'string') {
          scheduleExpr = job.schedule;
        } else if (job.schedule.expr) {
          scheduleExpr = job.schedule.expr;
          
          // 简单解析cron表达式
          const expr = job.schedule.expr;
          if (expr === '0 9 * * *') {
            nextRun = '每天 9:00';
          } else if (expr === '0 8,20 * * *') {
            nextRun = '每天 8:00, 20:00';
          } else if (expr === '0 12 * * *') {
            nextRun = '每天 12:00';
          } else if (expr === '0 22 * * *') {
            nextRun = '每天 22:00';
          } else if (expr === '0 10 * * 0') {
            nextRun = '每周日 10:00';
          } else if (expr.includes('* * * * *')) {
            nextRun = '每分钟';
          }
        }
      }
      
      // 根据任务名称判断任务类型
      let taskType = '其他任务';
      const jobName = (job.name || '').toLowerCase();
      if (jobName.includes('音乐') || jobName.includes('music')) {
        taskType = '🎵 音乐推荐';
      } else if (jobName.includes('金价') || jobName.includes('gold')) {
        taskType = '💰 金价监控';
      } else if (jobName.includes('天气') || jobName.includes('weather')) {
        taskType = '🌤️ 天气播报';
      } else if (jobName.includes('小红书') || jobName.includes('xhs')) {
        taskType = '📕 小红书';
      } else if (jobName.includes('签到') || jobName.includes('xmrth')) {
        taskType = '✍️ 自动签到';
      } else if (jobName.includes('早安') || jobName.includes('morning')) {
        taskType = '☀️ 早安资讯';
      } else if (jobName.includes('晚安') || jobName.includes('night')) {
        taskType = '🌙 晚安资讯';
      } else if (jobName.includes('教程') || jobName.includes('tutorial')) {
        taskType = '📚 技术教程';
      }
      
      // 从state中获取下次执行时间和状态
      const state = job.state || {};
      const lastRunAt = state.lastRunAtMs ? new Date(state.lastRunAtMs).toLocaleString('zh-CN') : '--';
      const lastStatus = state.lastRunStatus || '--';
      
      return {
        id: job.id || 'unknown',
        name: job.name || job.id || 'Unknown',
        schedule: scheduleExpr,
        nextRun: nextRun,
        taskType: taskType,
        enabled: job.enabled !== false,
        lastRun: lastRunAt,
        lastStatus: lastStatus
      };
    });
    
    res.json(jobList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Telegram Status
app.get('/api/telegram', async (req, res) => {
  try {
    const config = JSON.parse(readFile(OPENCLAW_DIR + '/openclaw.json') || '{}');
    const telegramDir = OPENCLAW_DIR + '/telegram';
    
    let sessions = [];
    if (fs.existsSync(telegramDir)) {
      const files = fs.readdirSync(telegramDir);
      sessions = files.filter(f => f.endsWith('.json')).map(f => {
        const data = JSON.parse(readFile(path.join(telegramDir, f)) || '{}');
        return {
          file: f,
          ...data
        };
      });
    }

    res.json({
      enabled: config.channels?.telegram?.enabled || false,
      botToken: config.channels?.telegram?.botToken ? '***configured***' : 'not set',
      groups: config.channels?.telegram?.groups || {},
      sessions: sessions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Sessions
app.get('/api/sessions', async (req, res) => {
  try {
    // Get delivery queue sessions
    const sessionsDir = OPENCLAW_DIR + '/delivery-queue';
    let deliveryQueue = [];
    
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      deliveryQueue = files.filter(f => f.endsWith('.json')).slice(0, 20).map(f => {
        const data = JSON.parse(readFile(path.join(sessionsDir, f)) || '{}');
        return {
          id: f.replace('.json', ''),
          type: 'delivery-queue',
          ...data
        };
      });
    }
    
    // Get Telegram sessions info
    const telegramDir = OPENCLAW_DIR + '/telegram';
    let telegramSessions = [];
    
    if (fs.existsSync(telegramDir)) {
      const files = fs.readdirSync(telegramDir);
      telegramSessions = files.filter(f => f.startsWith('update-offset-') && f.endsWith('.json')).map(f => {
        const data = JSON.parse(readFile(path.join(telegramDir, f)) || '{}');
        return {
          id: f.replace('update-offset-', '').replace('.json', ''),
          type: 'telegram',
          lastUpdate: data.lastUpdate || data.last_offset || null,
          ...data
        };
      });
    }
    
    // Get agent sessions (recent conversations)
    const agentSessions = [];
    const agentMainDir = OPENCLAW_DIR + '/agents/main/sessions';
    if (fs.existsSync(agentMainDir)) {
      const files = fs.readdirSync(agentMainDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort((a, b) => {
          const statA = fs.statSync(path.join(agentMainDir, a));
          const statB = fs.statSync(path.join(agentMainDir, b));
          return statB.mtime - statA.mtime;
        })
        .slice(0, 10);
      
      for (const f of files) {
        const filePath = path.join(agentMainDir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        
        // Get first and last message for context
        let firstMsg = null, lastMsg = null, msgCount = lines.length;
        if (lines.length > 0) {
          try { firstMsg = JSON.parse(lines[0]); } catch {}
          try { lastMsg = JSON.parse(lines[lines.length - 1]); } catch {}
        }
        
        // Determine session type from filename
        const isTopic = f.includes('-topic-');
        const sessionId = f.replace('.jsonl', '');
        
        agentSessions.push({
          id: sessionId,
          type: isTopic ? 'topic' : 'dm',
          file: f,
          size: stat.size,
          messages: msgCount,
          lastUpdate: stat.mtime.toISOString(),
          firstTimestamp: firstMsg?.timestamp || null,
          lastTimestamp: lastMsg?.timestamp || null,
          isDeleted: f.includes('.deleted.')
        });
      }
    }

    // Get active sessions from delivery-queue
    const activeSessions = deliveryQueue.filter(s => !s.id.includes('failed'));
    const failedSessions = deliveryQueue.filter(s => s.id.includes('failed'));

    res.json({
      deliveryQueue,
      telegram: telegramSessions,
      agentSessions,
      summary: {
        activeCount: activeSessions.length,
        failedCount: failedSessions.length,
        telegramCount: telegramSessions.length,
        agentCount: agentSessions.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Token Usage
app.get('/api/usage', async (req, res) => {
  try {
    // 尝试从日志中解析token使用量
    const logFile = OPENCLAW_DIR + '/logs/gateway.log';
    let totalTokens = 0;
    let requestCount = 0;
    let modelUsage = {};
    
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.split('\n').slice(-500);
      
      // 从日志中解析token使用（如果有的话）
      for (const line of lines) {
        try {
          const logEntry = JSON.parse(line);
          if (logEntry.usage || logEntry.tokenUsage) {
            const usage = logEntry.usage || logEntry.tokenUsage;
            const tokens = (usage.input_tokens || usage.inputTokens || 0) + 
                          (usage.output_tokens || usage.outputTokens || 0);
            if (tokens > 0) {
              totalTokens += tokens;
              requestCount++;
              const model = logEntry.model || 'unknown';
              if (!modelUsage[model]) modelUsage[model] = 0;
              modelUsage[model] += tokens;
            }
          }
        } catch {}
      }
    }

    // 如果没有使用数据，显示配置中的模型信息
    const config = JSON.parse(readFile(OPENCLAW_DIR + '/openclaw.json') || '{}');
    const providers = config.models?.providers || {};
    
    if (Object.keys(modelUsage).length === 0) {
      // 显示配置中的模型作为参考
      for (const [provider, cfg] of Object.entries(providers)) {
        for (const model of cfg.models || []) {
          const modelId = provider + '/' + model.id;
          modelUsage[modelId] = {
            tokens: 0,
            percent: 0,
            configured: true
          };
        }
      }
    }
    
    // 整理输出
    const models = {};
    for (const [model, data] of Object.entries(modelUsage)) {
      if (typeof data === 'object' && data.configured) {
        models[model] = { tokens: 0, percent: 0, configured: true };
      } else {
        const tokens = typeof data === 'number' ? data : (data.tokens || 0);
        models[model] = {
          tokens,
          percent: totalTokens > 0 ? Math.round(tokens / totalTokens * 100) : 0
        };
      }
    }

    res.json({
      totalTokens,
      requestCount,
      models,
      note: Object.keys(modelUsage).length === 0 || Object.values(modelUsage).every(v => v.tokens === 0) ? 
            '暂无使用量统计' : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Weather
app.get('/api/weather', (req, res) => {
  if (!WEATHER_TOKEN) {
    res.json({ error: 'OpenWeatherMap Token未配置', configNeeded: true });
    return;
  }
  
  const lat = 39.9042;
  const lon = 116.4074;
  const currentUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&lang=zh_cn&appid=${WEATHER_TOKEN}`;
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=metric&lang=zh_cn&cnt=8&appid=${WEATHER_TOKEN}`;
  
  // Get current weather
  https.get(currentUrl, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        const weather = JSON.parse(data);
        if (weather.cod === 401) {
          res.json({ error: 'Token无效', configNeeded: true });
          return;
        }
        
        // Get forecast
        https.get(forecastUrl, (fcResponse) => {
          let fcData = '';
          fcResponse.on('data', chunk => fcData += chunk);
          fcResponse.on('end', () => {
            try {
              const forecast = JSON.parse(fcData);
              const forecastList = (forecast.list || []).slice(0, 5).map(item => ({
                time: item.dt_txt.split(' ')[1].substring(0, 5),
                temp: Math.round(item.main.temp),
                icon: item.weather?.[0]?.icon || '',
                desc: item.weather?.[0]?.description || ''
              }));
              
              res.json({
                temp: Math.round(weather.main?.temp || 0),
                feels_like: Math.round(weather.main?.feels_like || 0),
                humidity: weather.main?.humidity || 0,
                description: weather.weather?.[0]?.description || '',
                icon: weather.weather?.[0]?.icon || '',
                city: weather.name || 'Beijing',
                forecast: forecastList
              });
            } catch {
              res.json({
                temp: Math.round(weather.main?.temp || 0),
                feels_like: Math.round(weather.main?.feels_like || 0),
                humidity: weather.main?.humidity || 0,
                description: weather.weather?.[0]?.description || '',
                icon: weather.weather?.[0]?.icon || '',
                city: weather.name || 'Beijing',
                forecast: []
              });
            }
          });
        }).on('error', () => {
          res.json({
            temp: Math.round(weather.main?.temp || 0),
            feels_like: Math.round(weather.main?.feels_like || 0),
            humidity: weather.main?.humidity || 0,
            description: weather.weather?.[0]?.description || '',
            icon: weather.weather?.[0]?.icon || '',
            city: weather.name || 'Beijing',
            forecast: []
          });
        });
      } catch {
        res.json({ error: '解析天气数据失败' });
      }
    });
  }).on('error', (error) => {
    res.json({ error: error.message });
  });
});

// API: Logs with filtering support
app.get('/api/logs', async (req, res) => {
  try {
    const { lines = 200, file = 'gateway.log', filter = '' } = req.query;
    const logFile = OPENCLAW_DIR + '/tmp/logs/' + file;
    
    if (fs.existsSync(logFile)) {
      let content = fs.readFileSync(logFile, 'utf8');
      
      // Apply filter if provided
      if (filter) {
        const filterLower = filter.toLowerCase();
        const allLines = content.split('\n');
        content = allLines.filter(line => line.toLowerCase().includes(filterLower)).join('\n');
        // Get last N lines after filtering
        const filteredLines = content.split('\n').slice(-parseInt(lines));
        content = filteredLines.join('\n');
      } else {
        const allLines = content.split('\n');
        content = allLines.slice(-parseInt(lines)).join('\n');
      }
      
      const stats = fs.statSync(logFile);
      res.json({
        content,
        modified: stats.mtime.getTime(),
        availableFiles: ['gateway.log', 'gateway.error.log', 'gateway.err.log', 'config-audit.jsonl']
      });
    } else {
      res.json({ content: 'Log file not found', modified: 0, availableFiles: [] });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: System Info
app.get('/api/system', async (req, res) => {
  try {
    const uptime = await execAsync('uptime');
    res.json({
      uptime: uptime.trim()
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// API: Config Files List
app.get('/api/configs', (req, res) => {
  try {
    const configs = [
      { id: 'openclaw.json', name: 'OpenClaw 主配置', path: OPENCLAW_DIR + '/openclaw.json' },
      { id: 'AGENTS.md', name: 'Agent配置', path: WORKSPACE_DIR + '/AGENTS.md' },
      { id: 'SOUL.md', name: '身份配置', path: WORKSPACE_DIR + '/SOUL.md' },
      { id: 'TOOLS.md', name: '工具配置', path: WORKSPACE_DIR + '/TOOLS.md' },
      { id: 'USER.md', name: '用户配置', path: WORKSPACE_DIR + '/USER.md' },
      { id: 'MEMORY.md', name: '长期记忆', path: WORKSPACE_DIR + '/MEMORY.md' },
      { id: 'HEARTBEAT.md', name: '心跳配置', path: WORKSPACE_DIR + '/HEARTBEAT.md' }
    ];
    
    const result = configs.map(c => {
      const exists = fs.existsSync(c.path);
      let content = '';
      let size = 0;
      let modified = null;
      
      if (exists) {
        const stats = fs.statSync(c.path);
        size = stats.size;
        modified = stats.mtime.toISOString();
        if (c.path.endsWith('.json')) {
          const data = JSON.parse(readFile(c.path) || '{}');
          content = JSON.stringify(data, null, 2);
        } else {
          content = readFile(c.path) || '';
        }
      }
      
      return { ...c, exists, size, modified, content: content.substring(0, 50000) };
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Backup - Create (Git commit)
// Check git config
async function checkGitConfig() {
  try {
    const userName = (await execAsync(`cd "${OPENCLAW_DIR}" && git config user.name`).catch(() => '')).trim();
    const userEmail = (await execAsync(`cd "${OPENCLAW_DIR}" && git config user.email`).catch(() => '')).trim();
    if (!userName || !userEmail) {
      return { configured: false, message: '请先配置 Git: git config --global user.name "你的名字" && git config --global user.email "你的邮箱"' };
    }
    return { configured: true };
  } catch (e) {
    return { configured: false, message: 'Git 未配置或非 Git 仓库' };
  }
}

app.post('/api/backup', express.json(), async (req, res) => {
  try {
    const gitCheck = await checkGitConfig();
    if (!gitCheck.configured) {
      return res.status(400).json({ error: gitCheck.message });
    }
    
    const { message: customMsg } = req.body || {};
    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}`;
    
    // Check if there are changes, if not amend current commit
    const statusCmd = `cd "${OPENCLAW_DIR}" && git status --porcelain`;
    const status = await execAsync(statusCmd).catch(() => '');
    
    let cmd, desc;
    if (status && status.trim()) {
      // 有改动
      desc = customMsg || `日常备份（${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${timestamp}）`;
      cmd = `cd "${OPENCLAW_DIR}" && git add -A && git commit -m "${desc}" 2>&1`;
    } else {
      // 无改动，amend
      const lastMsg = (await execAsync(`cd "${OPENCLAW_DIR}" && git log -1 --format="%s"`).catch(() => '')).trim();
      desc = customMsg ? `${lastMsg} + ${customMsg}` : `${lastMsg} +${timestamp}`;
      cmd = `cd "${OPENCLAW_DIR}" && git commit --amend -m "${desc}" 2>&1`;
    }
    const output = await execAsync(cmd).catch(e => e.message);
    
    res.json({ success: true, message: '备份成功（本地）', output: output.substring(0, 1000) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Backup - Check status
app.get('/api/backup/status', async (req, res) => {
  try {
    const gitCheck = await checkGitConfig();
    if (!gitCheck.configured) {
      return res.status(400).json({ error: gitCheck.message });
    }
    
    const statusCmd = `cd "${OPENCLAW_DIR}" && git status --porcelain`;
    const status = await execAsync(statusCmd).catch(() => '');
    
    if (status && status.trim()) {
      // 有改动，返回改动文件列表
      const files = status.split('\n').filter(l => l.trim()).map(l => {
        const prefix = l.substring(0, 2);
        const file = l.substring(3);
        return { status: prefix.trim(), file };
      });
      res.json({ hasChanges: true, files });
    } else {
      res.json({ hasChanges: false, files: [] });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Backup - List (Git log)
app.get('/api/backups', async (req, res) => {
  try {
    const cmd = `cd "${OPENCLAW_DIR}" && git log --oneline -5 2>&1`;
    const output = await execAsync(cmd).catch(() => '');
    
    const commits = String(output).split('\n').filter(l => l.trim()).map(line => {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
      if (match) {
        return { name: match[1], description: match[2] };
      }
      return null;
    }).filter(c => c);
    
    res.json(commits);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Backup - Details (Git show)
app.get('/api/backup/:name/details', async (req, res) => {
  try {
    const { name } = req.params;
    const cmd = `cd "${OPENCLAW_DIR}" && git show ${name} --stat --format="%H%n%an%n%ae%n%ci%n%s%n---%b" 2>&1 | head -50`;
    const output = await execAsync(cmd).catch(() => '');
    
    res.json({ name, details: output.substring(0, 2000) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Backup - Restore (Git checkout)
app.post('/api/backup/:name/restore', async (req, res) => {
  try {
    const gitCheck = checkGitConfig();
    if (!gitCheck.configured) {
      return res.status(400).json({ error: gitCheck.message });
    }
    
    const { name } = req.params;
    const cmd = `cd "${OPENCLAW_DIR}" && git checkout ${name} -- . 2>&1`;
    const output = await execAsync(cmd).catch(e => e.message);
    
    res.json({ success: true, message: '恢复成功', output: output.substring(0, 1000) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Config - Save
app.post('/api/config/save', express.json(), (req, res) => {
  try {
    const { id, content } = req.body;
    
    if (!id || content === undefined) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    // Find config path
    const configs = [
      { id: 'openclaw.json', path: OPENCLAW_DIR + '/openclaw.json' },
      { id: 'jobs.json', path: OPENCLAW_DIR + '/jobs.json' },
      { id: 'AGENTS.md', path: WORKSPACE_DIR + '/AGENTS.md' },
      { id: 'SOUL.md', path: WORKSPACE_DIR + '/SOUL.md' },
      { id: 'TOOLS.md', path: WORKSPACE_DIR + '/TOOLS.md' },
      { id: 'USER.md', path: WORKSPACE_DIR + '/USER.md' },
      { id: 'MEMORY.md', path: WORKSPACE_DIR + '/MEMORY.md' },
      { id: 'HEARTBEAT.md', path: WORKSPACE_DIR + '/HEARTBEAT.md' }
    ];
    
    const config = configs.find(c => c.id === id);
    if (!config) {
      return res.status(404).json({ error: '未知配置文件' });
    }
    
    // Validate JSON if needed
    if (id.endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch (e) {
        return res.status(400).json({ error: 'JSON格式错误: ' + e.message });
      }
    }
    
    // Save
    fs.writeFileSync(config.path, content, 'utf8');
    
    res.json({ success: true, message: '配置已保存', path: config.path });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Cron Job - Update
app.post('/api/cron/update', express.json(), (req, res) => {
  try {
    const { jobId, updates } = req.body;
    
    if (!jobId || !updates) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    
    const jobsPath = OPENCLAW_DIR + '/jobs.json';
    const jobsData = JSON.parse(readFile(jobsPath) || '{}');
    const jobs = jobsData.jobs || [];
    
    const jobIndex = jobs.findIndex(j => j.id === jobId);
    if (jobIndex === -1) {
      return res.status(404).json({ error: '未找到定时任务' });
    }
    
    // Apply updates
    if (updates.enabled !== undefined) jobs[jobIndex].enabled = updates.enabled;
    if (updates.name !== undefined) jobs[jobIndex].name = updates.name;
    if (updates.schedule !== undefined) {
      jobs[jobIndex].schedule = {
        kind: 'cron',
        expr: updates.schedule,
        tz: 'Asia/Shanghai'
      };
    }
    if (updates.sessionTarget !== undefined) jobs[jobIndex].sessionTarget = updates.sessionTarget;
    if (updates.wakeMode !== undefined) jobs[jobIndex].wakeMode = updates.wakeMode;
    
    // Save
    writeFile(jobsPath, JSON.stringify(jobsData, null, 2));
    
    res.json({ success: true, message: '定时任务已更新' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Gateway Control
app.post('/api/gateway/restart', async (req, res) => {
  try {
    const output = await execAsync('export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && openclaw gateway restart 2>&1');
    res.json({ success: true, message: 'Gateway正在重启...', output: output.substring(0, 500) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Doctor Fix
app.post('/api/doctor/fix', async (req, res) => {
  try {
    const output = await execAsync('export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && openclaw doctor fix 2>&1');
    res.json({ success: true, output: output.substring(0, 5000) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Current Time
app.get('/api/time', (req, res) => {
  const now = new Date();
  const hour = now.getHours();
  let greeting = '你好';
  if (hour >= 5 && hour < 9) greeting = '早上好';
  else if (hour >= 9 && hour < 12) greeting = '上午好';
  else if (hour >= 12 && hour < 14) greeting = '中午好';
  else if (hour >= 14 && hour < 18) greeting = '下午好';
  else if (hour >= 18 && hour < 22) greeting = '晚上好';
  
  res.json({
    time: now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
    timestamp: now.getTime(),
    greeting
  });
});

// Proxy to official OpenClaw Dashboard (127.0.0.1:18789)
app.use('/proxy-dashboard', (req, res) => {
  const targetUrl = 'http://127.0.0.1:18789' + req.url;
  
  const proxyReq = http.request(targetUrl, { method: req.method }, (proxyRes) => {
    let data = '';
    
    if (req.url === '/' || req.url === '') {
      // Rewrite HTML to fix asset paths
      proxyRes.on('data', chunk => {
        data += chunk;
      });
      
      proxyRes.on('end', () => {
        // Fix relative URLs in HTML
        let rewritten = data
          .replace(/href="\.\//g, 'href="/proxy-dashboard/')
          .replace(/src="\.\//g, 'src="/proxy-dashboard/');
        
        // Also fix the WebSocket URL
        rewritten = rewritten.replace(/ws:\/\/127\.0\.0\.1:18789/g, 'ws://127.0.0.1:18789');
        
        res.writeHead(proxyRes.statusCode, {
          ...proxyRes.headers,
          'Content-Length': Buffer.byteLength(rewritten)
        });
        res.end(rewritten);
      });
    } else {
      // Pass through other requests (assets)
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  });
  
  req.pipe(proxyReq, { end: true });
});

// Proxy to OpenClaw WebUI (with token)
app.use('/proxy-webui', (req, res) => {
  const targetUrl = 'http://127.0.0.1:18789' + req.url;
  
  const proxyReq = http.request(targetUrl, { method: req.method }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res, { end: true });
  });
  
  req.pipe(proxyReq, { end: true });
});

// ========== Chat API ==========
const OPENCLAW_TOKEN = '4094e456d7bf7d25319b41ffd460f839ac986f42e597483c';

// Get sessions list
app.get('/api/chat/sessions', async (req, res) => {
  try {
    const sessionsFile = OPENCLAW_DIR + '/agents/main/sessions/sessions.json';
    const sessions = [];
    
    // Load custom names
    const metaFile = WORKSPACE_DIR + '/openclaw-chat-web/sessions_meta.json';
    let meta = {};
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    }
    
    if (fs.existsSync(sessionsFile)) {
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      for (const key of Object.keys(data)) {
        if (key.startsWith('agent:main:telegram:') || key.startsWith('agent:main:web:')) {
          let name = meta[key] || key;
          
          // Format Telegram sessions
          if (key.includes('telegram:')) {
            if (key.includes('topic:')) {
              name = 'Topic #' + key.split('topic:')[1];
            } else if (key.includes('direct:')) {
              const username = key.split('direct:')[1];
              name = username.startsWith('@') ? username : '私聊';
            }
            // Override with custom name if exists
            if (meta[key]) name = meta[key];
          }
          
          sessions.push({
            key,
            name,
            type: key.includes('telegram') ? 'telegram' : 'web',
            updatedAt: data[key].updatedAt || 0
          });
        }
      }
    }
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create new session
app.post('/api/chat/sessions', async (req, res) => {
  try {
    const uuid = require('crypto').randomBytes(4).toString('hex');
    const sessionKey = 'agent:main:web:' + uuid;
    const name = req.body.name || '新会话';
    
    // Save custom name
    const metaFile = WORKSPACE_DIR + '/openclaw-chat-web/sessions_meta.json';
    let meta = {};
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    }
    meta[sessionKey] = name;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    
    res.json({ key: sessionKey, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename session
app.post('/api/chat/sessions/:key/rename', async (req, res) => {
  try {
    const { key } = req.params;
    const { name } = req.body;
    
    const metaFile = WORKSPACE_DIR + '/openclaw-chat-web/sessions_meta.json';
    let meta = {};
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    }
    meta[key] = name;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 重命名会话 (PUT)
app.put('/api/chat/sessions/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { name } = req.body;
    
    const metaFile = WORKSPACE_DIR + '/openclaw-chat-web/sessions_meta.json';
    let meta = {};
    if (fs.existsSync(metaFile)) {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    }
    meta[key] = name;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除会话 (DELETE)
app.delete('/api/chat/sessions/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    const metaFile = WORKSPACE_DIR + '/openclaw-chat-web/sessions_meta.json';
    if (fs.existsSync(metaFile)) {
      let meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      delete meta[key];
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    }
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat completion
app.post('/api/chat/completions', async (req, res) => {
  try {
    const sessionKey = req.headers['x-openclaw-session-key'] || '';
    
    const body = JSON.stringify(req.body);
    
    const options = {
      hostname: '127.0.0.1',
      port: 18789,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENCLAW_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    
    if (sessionKey) {
      options.headers['X-Openclaw-Session-Key'] = sessionKey;
    }
    
    const response = await new Promise((resolve, reject) => {
      const req = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        proxyRes.pipe(res, { end: true });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 聊天记录存储目录
const chatMessagesDir = WORKSPACE_DIR + '/openclaw-chat-web/messages';
if (!fs.existsSync(chatMessagesDir)) {
  fs.mkdirSync(chatMessagesDir, { recursive: true });
}

// 读取 OpenClaw 会话历史
function getOpenClawMessages(key) {
  try {
    const sessionsFile = OPENCLAW_DIR + '/agents/main/sessions/sessions.json';
    if (!fs.existsSync(sessionsFile)) return null;
    
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const session = sessions[key];
    if (!session || !session.sessionFile || !fs.existsSync(session.sessionFile)) return null;
    
    const lines = fs.readFileSync(session.sessionFile, 'utf8').trim().split('\n');
    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // 过滤非消息类型（跳过 thinking、toolCall、model_change 等中间状态）
        if (entry.type && entry.type !== 'message') continue;
        
        // 兼容多种格式
        if (entry.message && entry.message.role && entry.message.content) {
          const msg = entry.message;
          // 过滤 thinking 和 toolCall
          if (msg.role === 'thinking' || msg.role === 'tool-call' || msg.role === 'tool') continue;
          let content = msg.content;
          if (Array.isArray(content)) {
            content = content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('');
          }
          // 过滤空消息和 thinking 内容
          if (!content || content === '[thinking]' || content === '[toolCall]') continue;
          if (content.startsWith('[thinking]') || content.startsWith('[toolCall]')) continue;
          // 过滤包含历史消息的内容
          if (content.includes('[Chat messages since') || content.includes('[Current message')) continue;
          // 过滤 git commit
          if (content.includes('[main ') || content.match(/^\[\w+\s+\w+\]/)) continue;
          // 过滤包含代码或命令的消息
          if (content.includes('{') && content.includes('}') && content.includes(':')) continue;
          if (content.match(/^\d+:/)) continue;
          if (content.includes('/') && content.includes('.') && content.match(/\w+\.\w+/)) continue;
          if (content.match(/^[a-z]:\\/i)) continue;
          if (content.match(/\b(tcp|udp|http|https|ftp|ssh|git)\b/i) && content.length < 100) continue;
          if (content.includes('not found') || content.includes('Command') || content.includes('error') || content.includes('Error')) continue;
          if (content.includes('zsh:') || content.includes('bash:') || content.includes('$ ') || content.includes('端口')) continue;
          if (content.includes('<') && content.includes('>') && !content.includes('《')) continue;
          // 过滤只包含特殊字符或数字
          if (!content.match(/[\u4e00-\u9fa5]/) && !content.match(/[a-zA-Z]{3,}/)) continue;
          // 过滤过短或过长的消息
          if (content.length < 4 || content.length > 600) continue;
          // 只保留 user 消息和看起来像正常回复的 assistant 消息
          if (msg.role === 'user' || content.match(/[\u4e00-\u9fa5]/)) {
            messages.push({ role: msg.role, content: content });
          }
        } else if (entry.role && entry.content && entry.role !== 'thinking' && entry.role !== 'tool-call') {
          // 直接是消息格式
          let content = entry.content;
          if (Array.isArray(content)) {
            content = content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('');
          }
          // 过滤空消息
          if (!content || content === '[thinking]' || content === '[toolCall]') continue;
          if (content.startsWith('[thinking]') || content.startsWith('[toolCall]')) continue;
          // 过滤历史消息
          if (content.includes('[Chat messages since') || content.includes('[Current message')) continue;
          // 过滤 git commit
          if (content.includes('[main ') || content.match(/^\[\w+\s+\w+\]/)) continue;
          // 过滤包含代码或命令的消息
          if (content.includes('{') && content.includes('}') && content.includes(':')) continue;
          if (content.match(/^\d+:/)) continue;
          if (content.includes('/') && content.includes('.') && content.match(/\w+\.\w+/)) continue;
          if (content.match(/^[a-z]:\\/i)) continue;
          if (content.match(/\b(tcp|udp|http|https|ftp|ssh|git)\b/i) && content.length < 100) continue;
          if (content.includes('not found') || content.includes('Command') || content.includes('error') || content.includes('Error')) continue;
          if (content.includes('zsh:') || content.includes('bash:') || content.includes('$ ') || content.includes('端口')) continue;
          if (content.includes('<') && content.includes('>') && !content.includes('《')) continue;
          if (!content.match(/[\u4e00-\u9fa5]/) && !content.match(/[a-zA-Z]{3,}/)) continue;
          if (content.length < 4 || content.length > 600) continue;
          // 只保留 user 消息和包含中文的 assistant 消息
          if (entry.role === 'user' || content.match(/[\u4e00-\u9fa5]/)) {
            messages.push({ role: entry.role, content: content });
          }
        }
      } catch (e) {}
    }
    return messages.length > 0 ? messages : null;
  } catch (e) {
    return null;
  }
}

// 获取聊天记录（优先从 OpenClaw 读取）
app.get('/api/chat/messages/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    // 1. 优先从 OpenClaw 读取（针对 telegram 会话）
    const openclawMsgs = getOpenClawMessages(key);
    if (openclawMsgs) {
      res.json(openclawMsgs);
      return;
    }
    
    // 2. 从 Dashboard 本地存储读取
    const filePath = chatMessagesDir + '/' + key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    if (fs.existsSync(filePath)) {
      const messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json(messages);
    } else {
      res.json([]);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 保存聊天记录（只保存网页会话，Telegram 会话直接用 OpenClaw 的历史）
app.post('/api/chat/messages/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { messages } = req.body;
    
    // 只保存网页会话的消息，Telegram 会话直接用 OpenClaw 的历史
    if (key.includes('telegram')) {
      res.json({ success: true, note: 'telegram session uses openclaw history' });
      return;
    }
    
    const filePath = chatMessagesDir + '/' + key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除聊天记录
app.delete('/api/chat/messages/:key', async (req, res) => {
  try {
    const key = req.params.key;
    const filePath = chatMessagesDir + '/' + key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Start server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Dashboard running on http://0.0.0.0:${PORT}`);
});
