const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const math = require('mathjs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DATASETS_FILE = path.join(DATA_DIR, 'datasets.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const RECOVERY_FILE = path.join(DATA_DIR, 'recovery.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATASETS_FILE)) {
    fs.writeFileSync(DATASETS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(RECOVERY_FILE)) {
    fs.writeFileSync(RECOVERY_FILE, JSON.stringify([], null, 2));
  }
}
ensureDataFiles();

function readJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return [];
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function linearRegression(points) {
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  points.forEach(p => {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  });
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { a: slope, b: intercept };
}

function exponentialRegression(points) {
  const invalidPoints = points.filter(p => p.y <= 0);
  if (invalidPoints.length > 0) {
    const indices = invalidPoints.map((_, i) => {
      const idx = points.indexOf(invalidPoints[i]) + 1;
      return `#${idx}(y=${invalidPoints[i].y})`;
    }).join(', ');
    throw new Error(`指数拟合要求所有Y值必须大于0，存在非法点: ${indices}`);
  }
  const n = points.length;
  const logPoints = points.map(p => ({ x: p.x, y: Math.log(p.y) }));
  const linearResult = linearRegression(logPoints);
  return { a: Math.exp(linearResult.b), b: linearResult.a };
}

function quadraticRegression(points) {
  const n = points.length;
  const rows = points.map(p => [p.x * p.x, p.x, 1]);
  const A = math.matrix(rows);
  const b = math.matrix(points.map(p => p.y));
  const AT = math.transpose(A);
  const ATA = math.multiply(AT, A);
  const ATb = math.multiply(AT, b);
  try {
    const ATAInv = math.inv(ATA);
    const x = math.multiply(ATAInv, ATb);
    const result = x.toArray();
    return { a: result[0], b: result[1], c: result[2] };
  } catch (e) {
    return { a: 0, b: 0, c: 0 };
  }
}

function calculateMetrics(points, modelType, params) {
  const n = points.length;
  let yMean = 0;
  points.forEach(p => yMean += p.y);
  yMean /= n;

  let ssTotal = 0;
  let ssResidual = 0;
  const residuals = [];
  let maeSum = 0;
  let rmseSum = 0;

  points.forEach(p => {
    let predicted;
    switch (modelType) {
      case 'linear':
        predicted = params.a * p.x + params.b;
        break;
      case 'exponential':
        predicted = params.a * Math.exp(params.b * p.x);
        break;
      case 'quadratic':
        predicted = params.a * p.x * p.x + params.b * p.x + params.c;
        break;
    }
    const residual = p.y - predicted;
    residuals.push(residual);
    ssResidual += residual * residual;
    ssTotal += (p.y - yMean) * (p.y - yMean);
    maeSum += Math.abs(residual);
    rmseSum += residual * residual;
  });

  const rSquared = 1 - (ssResidual / ssTotal);
  const mse = ssResidual / n;
  const rmse = Math.sqrt(rmseSum / n);
  const mae = maeSum / n;

  const residualStd = math.std(residuals);

  const outliers = residuals.map((r, i) => {
    const zScore = Math.abs(r - math.mean(residuals)) / residualStd;
    return { index: i, isOutlier: zScore > 2, zScore: zScore, residual: r };
  });

  return { rSquared, mse, rmse, mae, residuals, outliers };
}

function generateCurvePoints(points, modelType, params, numPoints = 100) {
  const xs = points.map(p => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const range = maxX - minX || 1;
  const extendedMin = minX - range * 0.1;
  const extendedMax = maxX + range * 0.1;
  const step = (extendedMax - extendedMin) / (numPoints - 1);
  const curvePoints = [];
  for (let i = 0; i < numPoints; i++) {
    const x = extendedMin + i * step;
    let y;
    switch (modelType) {
      case 'linear':
        y = params.a * x + params.b;
        break;
      case 'exponential':
        y = params.a * Math.exp(params.b * x);
        break;
      case 'quadratic':
        y = params.a * x * x + params.b * x + params.c;
        break;
    }
    curvePoints.push({ x, y });
  }
  return curvePoints;
}

app.get('/api/datasets', (req, res) => {
  const datasets = readJsonFile(DATASETS_FILE);
  res.json(datasets);
});

app.post('/api/datasets', (req, res) => {
  const { name, points } = req.body;
  if (!name || !points || !Array.isArray(points)) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const datasets = readJsonFile(DATASETS_FILE);
  const dataset = {
    id: generateId(),
    name,
    points,
    createdAt: new Date().toISOString()
  };
  datasets.push(dataset);
  writeJsonFile(DATASETS_FILE, datasets);
  res.json(dataset);
});

app.put('/api/datasets/:id', (req, res) => {
  const { id } = req.params;
  const { name, points } = req.body;
  const datasets = readJsonFile(DATASETS_FILE);
  const index = datasets.findIndex(d => d.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '数据集不存在' });
  }
  datasets[index].name = name || datasets[index].name;
  datasets[index].points = points || datasets[index].points;
  datasets[index].updatedAt = new Date().toISOString();
  writeJsonFile(DATASETS_FILE, datasets);
  res.json(datasets[index]);
});

app.delete('/api/datasets/:id', (req, res) => {
  const { id } = req.params;
  let datasets = readJsonFile(DATASETS_FILE);
  const initialLength = datasets.length;
  datasets = datasets.filter(d => d.id !== id);
  if (datasets.length === initialLength) {
    return res.status(404).json({ error: '数据集不存在' });
  }
  writeJsonFile(DATASETS_FILE, datasets);
  res.json({ success: true });
});

app.post('/api/fit', (req, res) => {
  const { datasetId, points, modelType, datasetName } = req.body;
  if (!points || !Array.isArray(points) || points.length < 2) {
    return res.status(400).json({ error: '至少需要2个数据点' });
  }
  if (!modelType) {
    return res.status(400).json({ error: '请选择拟合模型' });
  }

  let params;
  let modelEquation;

  try {
    switch (modelType) {
      case 'linear':
        params = linearRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)}x + ${params.b.toFixed(6)}`;
        break;
      case 'exponential':
        params = exponentialRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)} · e^(${params.b.toFixed(6)}x)`;
        break;
      case 'quadratic':
        params = quadraticRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)}x² + ${params.b.toFixed(6)}x + ${params.c.toFixed(6)}`;
        break;
      default:
        return res.status(400).json({ error: '不支持的模型类型' });
    }
  } catch (e) {
    return res.status(400).json({ error: '拟合计算失败: ' + e.message });
  }

  const metrics = calculateMetrics(points, modelType, params);
  const curvePoints = generateCurvePoints(points, modelType, params);

  const result = {
    id: generateId(),
    datasetId: datasetId || null,
    datasetName: datasetName || '未命名数据集',
    modelType,
    params,
    modelEquation,
    metrics: {
      rSquared: metrics.rSquared,
      mse: metrics.mse,
      rmse: metrics.rmse,
      mae: metrics.mae
    },
    residuals: metrics.residuals,
    outliers: metrics.outliers,
    curvePoints,
    points,
    createdAt: new Date().toISOString()
  };

  const history = readJsonFile(HISTORY_FILE);
  history.unshift(result);
  if (history.length > 50) {
    history.length = 50;
  }
  writeJsonFile(HISTORY_FILE, history);

  res.json(result);
});

app.get('/api/history', (req, res) => {
  const history = readJsonFile(HISTORY_FILE);
  const summaries = history.map(h => ({
    id: h.id,
    datasetId: h.datasetId,
    datasetName: h.datasetName,
    modelType: h.modelType,
    modelEquation: h.modelEquation,
    metrics: h.metrics,
    pointsCount: h.points.length,
    createdAt: h.createdAt
  }));
  res.json(summaries);
});

app.get('/api/history/:id', (req, res) => {
  const { id } = req.params;
  const history = readJsonFile(HISTORY_FILE);
  const result = history.find(h => h.id === id);
  if (!result) {
    return res.status(404).json({ error: '记录不存在' });
  }
  res.json(result);
});

app.delete('/api/history/:id', (req, res) => {
  const { id } = req.params;
  let history = readJsonFile(HISTORY_FILE);
  const initialLength = history.length;
  history = history.filter(h => h.id !== id);
  if (history.length === initialLength) {
    return res.status(404).json({ error: '记录不存在' });
  }
  writeJsonFile(HISTORY_FILE, history);
  res.json({ success: true });
});

function calculateConcentrationFromResponse(response, modelType, params) {
  switch (modelType) {
    case 'linear': {
      const a = params.a;
      const b = params.b;
      if (Math.abs(a) < 1e-12) return 0;
      return (response - b) / a;
    }
    case 'exponential': {
      const a = params.a;
      const b = params.b;
      if (a <= 0 || response <= 0 || Math.abs(b) < 1e-12) return 0;
      return Math.log(response / a) / b;
    }
    case 'quadratic': {
      const a = params.a;
      const b = params.b;
      const c = params.c;
      const discriminant = b * b - 4 * a * (c - response);
      if (discriminant < 0) return 0;
      const sqrtDiscriminant = Math.sqrt(discriminant);
      const x1 = (-b + sqrtDiscriminant) / (2 * a);
      const x2 = (-b - sqrtDiscriminant) / (2 * a);
      return Math.max(x1, x2);
    }
    default:
      return 0;
  }
}

function calculateRecoveryMetrics(points, recoveryMin, recoveryMax) {
  const recoveries = points.map(p => p.recovery);
  const n = recoveries.length;

  const sum = recoveries.reduce((a, b) => a + b, 0);
  const averageRecovery = sum / n;

  const minRecovery = Math.min(...recoveries);
  const maxRecovery = Math.max(...recoveries);

  const variance = recoveries.reduce((acc, val) => acc + Math.pow(val - averageRecovery, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const rsd = (stdDev / Math.abs(averageRecovery)) * 100;

  let passCount = 0, lowCount = 0, highCount = 0;
  recoveries.forEach(r => {
    if (r >= recoveryMin && r <= recoveryMax) {
      passCount++;
    } else if (r < recoveryMin) {
      lowCount++;
    } else {
      highCount++;
    }
  });

  const passRate = (passCount / n) * 100;
  const batchPass = passRate >= 80;

  return {
    totalCount: n,
    passCount,
    lowCount,
    highCount,
    passRate,
    averageRecovery,
    minRecovery,
    maxRecovery,
    rsd,
    batchPass
  };
}

app.post('/api/recovery/calculate', (req, res) => {
  const { batchName, modelType, recoveryMin, recoveryMax, points } = req.body;

  if (!points || !Array.isArray(points) || points.length < 3) {
    return res.status(400).json({ error: '至少需要3个有效实验点' });
  }
  if (!modelType) {
    return res.status(400).json({ error: '请选择拟合模型' });
  }

  const calibrationPoints = points.map(p => ({ x: p.theoretical / p.dilution, y: p.response }));

  let params;
  let modelEquation;

  try {
    switch (modelType) {
      case 'linear':
        params = linearRegression(calibrationPoints);
        modelEquation = `y = ${params.a.toFixed(6)}x + ${params.b.toFixed(6)}`;
        break;
      case 'exponential':
        params = exponentialRegression(calibrationPoints);
        modelEquation = `y = ${params.a.toFixed(6)} · e^(${params.b.toFixed(6)}x)`;
        break;
      case 'quadratic':
        params = quadraticRegression(calibrationPoints);
        modelEquation = `y = ${params.a.toFixed(6)}x² + ${params.b.toFixed(6)}x + ${params.c.toFixed(6)}`;
        break;
      default:
        return res.status(400).json({ error: '不支持的模型类型' });
    }
  } catch (e) {
    return res.status(400).json({ error: '标准曲线拟合失败: ' + e.message });
  }

  const calibrationMetrics = calculateMetrics(calibrationPoints, modelType, params);

  const results = points.map(p => {
    const calculatedConc = calculateConcentrationFromResponse(p.response, modelType, params);
    const actualConc = calculatedConc * p.dilution;
    const recovery = (actualConc / p.theoretical) * 100;
    return {
      theoretical: p.theoretical,
      response: p.response,
      dilution: p.dilution,
      calculatedConcentration: actualConc,
      recovery
    };
  });

  const summary = calculateRecoveryMetrics(results, recoveryMin, recoveryMax);

  const recoveryRecord = {
    id: generateId(),
    batchName: batchName || '未命名批次',
    modelType,
    recoveryMin: recoveryMin || 80,
    recoveryMax: recoveryMax || 120,
    points,
    calibration: {
      params,
      modelEquation,
      metrics: {
        rSquared: calibrationMetrics.rSquared,
        mse: calibrationMetrics.mse,
        rmse: calibrationMetrics.rmse,
        mae: calibrationMetrics.mae
      }
    },
    results,
    summary,
    createdAt: new Date().toISOString()
  };

  const recoveryHistory = readJsonFile(RECOVERY_FILE);
  recoveryHistory.unshift(recoveryRecord);
  if (recoveryHistory.length > 50) {
    recoveryHistory.length = 50;
  }
  writeJsonFile(RECOVERY_FILE, recoveryHistory);

  res.json(recoveryRecord);
});

app.get('/api/recovery/history', (req, res) => {
  const history = readJsonFile(RECOVERY_FILE);
  const summaries = history.map(h => ({
    id: h.id,
    batchName: h.batchName,
    modelType: h.modelType,
    recoveryMin: h.recoveryMin,
    recoveryMax: h.recoveryMax,
    summary: h.summary,
    createdAt: h.createdAt
  }));
  res.json(summaries);
});

app.get('/api/recovery/history/:id', (req, res) => {
  const { id } = req.params;
  const history = readJsonFile(RECOVERY_FILE);
  const result = history.find(h => h.id === id);
  if (!result) {
    return res.status(404).json({ error: '记录不存在' });
  }
  res.json(result);
});

app.delete('/api/recovery/history/:id', (req, res) => {
  const { id } = req.params;
  let history = readJsonFile(RECOVERY_FILE);
  const initialLength = history.length;
  history = history.filter(h => h.id !== id);
  if (history.length === initialLength) {
    return res.status(404).json({ error: '记录不存在' });
  }
  writeJsonFile(RECOVERY_FILE, history);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`实验曲线拟合台 服务器已启动: http://localhost:${PORT}`);
});
