require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;
const PHOTO_DIR = process.env.PHOTO_DIR || './uploads';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024; // 50MB
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || 'jpg,jpeg,png,gif,bmp,webp').split(',');

// 보안 및 CORS 설정
app.use(helmet({
  contentSecurityPolicy: false // 개발 편의성을 위해 비활성화
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*'
}));

// 미들웨어 설정
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '50mb',
  parameterLimit: 50000 
}));

app.use((req, res, next) => {
  res.set('Content-Type', 'application/json; charset=utf-8');
  next();
});

// 사진 파일 정적 서빙
app.use('/photos', express.static(PHOTO_DIR));

// 업로드 디렉토리 확인/생성
fs.ensureDirSync(PHOTO_DIR);
fs.ensureDirSync(path.join(PHOTO_DIR, 'temp'));

// Multer 설정 수정
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = req.body.folder || 'temp';
    const uploadDir = path.join(PHOTO_DIR, folder);
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // 한국어 파일명 디코딩
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .split('.')[0];
    const extension = path.extname(originalName).toLowerCase();
    const baseName = path.basename(originalName, extension);
    
    // 파일명에서 특수문자 제거 (한국어는 유지)
    const safeName = baseName
      .replace(/[<>:"/\\|?*]/g, '') // Windows 금지 문자 제거
      .replace(/\s+/g, '_'); // 공백을 언더스코어로 변경
    
    const finalName = `${timestamp}_${safeName}${extension}`;
    cb(null, finalName);
  }
});

const upload = multer({
  storage: storage,
  limits: { 
    fileSize: MAX_FILE_SIZE,
    files: 10
  },
  fileFilter: (req, file, cb) => {
    // 한국어 파일명 디코딩
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const extension = path.extname(originalName).toLowerCase().slice(1);
    const mimetype = file.mimetype.startsWith('image/');
    
    if (ALLOWED_EXTENSIONS.includes(extension) && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error(`허용되지 않는 파일 형식입니다. 허용 형식: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
  }
});


// 유틸리티 함수들
const getFileStats = (filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory()
    };
  } catch (error) {
    return null;
  }
};

const validatePath = (inputPath) => {
  // 경로 traversal 공격 방지
  const normalizedPath = path.normalize(inputPath);
  return !normalizedPath.includes('..');
};

// API 라우트들
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 폴더 목록 조회
app.get('/api/folders', async (req, res) => {
  try {
    const items = await fs.readdir(PHOTO_DIR);
    const folders = [];
    
    for (const item of items) {
      const itemPath = path.join(PHOTO_DIR, item);
      const stats = await fs.stat(itemPath);
      
      if (stats.isDirectory() && !item.startsWith('.')) {
        folders.push({
          name: item,
          path: item,
          created: stats.birthtime,
          modified: stats.mtime
        });
      }
    }
    
    // 수정일 기준으로 정렬
    folders.sort((a, b) => b.modified - a.modified);
    res.json(folders);
  } catch (error) {
    console.error('폴더 목록 조회 오류:', error);
    res.status(500).json({ error: '폴더 목록을 불러올 수 없습니다.' });
  }
});

// 사진 목록 조회
app.get('/api/photos', async (req, res) => {
  try {
    const targetDir = PHOTO_DIR;
    const files = await fs.readdir(targetDir);
    const photos = [];
    
    for (const file of files) {
        const filePath = path.join(targetDir, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile() && /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)) {
            const extension = path.extname(file).toLowerCase().slice(1) || 'unknown';
            photos.push({
                name: file,
                path: file,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                extension: extension // 안전한 확장자 처리
            });
        }
    }
    photos.sort((a, b) => b.modified - a.modified);
    res.json(photos);
  } catch (error) {
    console.error('루트 사진 목록 조회 오류:', error);
    res.status(500).json({ error: '사진 목록을 불러올 수 없습니다.' });
  }
});

app.get('/api/photos/:folder', async (req, res) => {
  try {
    const folder = req.params.folder;
    if (!validatePath(folder)) {
        return res.status(400).json({ error: '잘못된 경로입니다.' });
    }
    const targetDir = path.join(PHOTO_DIR, folder);
    
    if (!await fs.pathExists(targetDir)) {
      return res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
    }
    
    const files = await fs.readdir(targetDir);
    const photos = [];
    
    for (const file of files) {
        const filePath = path.join(targetDir, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile() && /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file)) {
            const extension = path.extname(file).toLowerCase().slice(1) || 'unknown';
            photos.push({
                name: file,
                path: `${folder}/${file}`,
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                extension: extension // 안전한 확장자 처리
            });
        }
    }
    photos.sort((a, b) => b.modified - a.modified);
    res.json(photos);
  } catch (error) {
    console.error(`'${req.params.folder}' 폴더 사진 목록 조회 오류:`, error);
    res.status(500).json({ error: '사진 목록을 불러올 수 없습니다.' });
  }
});


// 사진 업로드
app.post('/api/upload', upload.array('photos', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
    }
    
    const uploadedFiles = req.files.map(file => {
      // 한국어 원본 파일명 디코딩
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      
      return {
        original: originalName, // 디코딩된 원본 파일명
        saved: file.filename,   // 서버에 저장된 파일명
        size: file.size,
        folder: req.body.folder || 'temp',
        path: path.relative(PHOTO_DIR, file.path)
      };
    });
    
    console.log(`${uploadedFiles.length}개 파일 업로드 완료:`, 
      uploadedFiles.map(f => f.original));
    
    res.json({
      success: true,
      message: `${uploadedFiles.length}개 파일이 업로드되었습니다.`,
      files: uploadedFiles
    });
    
  } catch (error) {
    console.error('업로드 오류:', error);
    res.status(500).json({ error: error.message || '업로드 중 오류가 발생했습니다.' });
  }
});


// 사진 삭제
app.delete('/api/photos', async (req, res) => {
  try {
    const photoPath = req.query.path;
    
    if (!photoPath) {
      return res.status(400).json({ error: '삭제할 파일 경로가 필요합니다.' });
    }
    
    if (!validatePath(photoPath)) {
      return res.status(400).json({ error: '잘못된 경로입니다.' });
    }
    
    const fullPath = path.join(PHOTO_DIR, decodeURIComponent(photoPath));
    
    if (!await fs.pathExists(fullPath)) {
      return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    
    await fs.unlink(fullPath);
    console.log(`파일 삭제됨: ${photoPath}`);
    
    res.json({
      success: true,
      message: '사진이 삭제되었습니다.',
      deletedPath: photoPath
    });
    
  } catch (error) {
    console.error('삭제 오류:', error);
    res.status(500).json({ error: '파일 삭제 중 오류가 발생했습니다.' });
  }
});


// 새 폴더 생성
app.post('/api/folders', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '폴더 이름이 필요합니다.' });
    }
    
    const folderName = name.trim();
    
    if (!validatePath(folderName) || folderName.includes('/') || folderName.includes('\\')) {
      return res.status(400).json({ error: '잘못된 폴더 이름입니다.' });
    }
    
    const folderPath = path.join(PHOTO_DIR, folderName);
    
    if (await fs.pathExists(folderPath)) {
      return res.status(409).json({ error: '이미 존재하는 폴더 이름입니다.' });
    }
    
    await fs.ensureDir(folderPath);
    console.log(`새 폴더 생성: ${folderName}`);
    
    res.json({
      success: true,
      message: '폴더가 생성되었습니다.',
      folder: {
        name: folderName,
        path: folderName,
        created: new Date(),
        modified: new Date()
      }
    });
    
  } catch (error) {
    console.error('폴더 생성 오류:', error);
    res.status(500).json({ error: '폴더 생성 중 오류가 발생했습니다.' });
  }
});

// 시스템 정보 조회
app.get('/api/system', (req, res) => {
  try {
    res.json({
      nodeVersion: process.version,
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'production',
      photoDir: PHOTO_DIR,
      maxFileSize: MAX_FILE_SIZE,
      allowedExtensions: ALLOWED_EXTENSIONS
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 에러 핸들링 미들웨어
app.use((error, req, res, next) => {
  console.error('서버 오류:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: `파일 크기가 너무 큽니다. 최대 ${MAX_FILE_SIZE / 1024 / 1024}MB까지 허용됩니다.` 
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: '한 번에 최대 10개 파일까지 업로드할 수 있습니다.' });
    }
  }
  
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({ error: '요청한 페이지를 찾을 수 없습니다.' });
});

// 서버 시작
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🖼️  NAS 사진 갤러리 서버가 실행 중입니다`);
  console.log(`🌐 로컬 주소: http://localhost:${PORT}`);
  console.log(`📁 사진 디렉토리: ${path.resolve(PHOTO_DIR)}`);
  console.log(`⚙️  환경: ${process.env.NODE_ENV || 'production'}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 서버를 종료합니다...');
  process.exit(0);
});