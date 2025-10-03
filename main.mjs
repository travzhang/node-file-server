import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 33000;

const publicRoot = path.resolve(__dirname, "public");
fs.mkdirSync(publicRoot, { recursive: true });

function resolveSafePath(rootDir, ...segments) {
  const unsafePath = path.join(...segments);
  const resolved = path.resolve(rootDir, unsafePath);
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (!(resolved + path.sep).startsWith(normalizedRoot)) {
    throw new Error("Invalid path");
  }
  return resolved;
}

async function computeFileSha256Hex(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

app.use("/public", express.static(publicRoot, { index: false }));

app.get("/_health", (req, res) => {
  res.status(200).json({ ok: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const bucket = req.params.bucket;
      const rawKey = (req.body && (req.body.key || req.body.Key)) || "";
      const key = String(rawKey);
      const dirName = key ? path.dirname(key) : "";
      const finalDir = dirName === "." ? "" : dirName;
      const destDir = resolveSafePath(publicRoot, bucket, finalDir);
      fs.promises
        .mkdir(destDir, { recursive: true })
        .then(() => cb(null, destDir))
        .catch(cb);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    try {
      const rawKey = (req.body && (req.body.key || req.body.Key)) || "";
      const key = String(rawKey || "");
      const extSource = key || file.originalname || "";
      const ext = path.extname(extSource);
      const hash = crypto.randomBytes(16).toString("hex");
      const hashedName = `${hash}${ext}`;
      cb(null, hashedName);
    } catch (err) {
      cb(err);
    }
  },
});

const upload = multer({ storage });

app.post("/:bucket", upload.single("file"), async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const rawKey = (req.body && (req.body.key || req.body.Key)) || "";
    const fullKey = String(rawKey || "");
    const dirName = fullKey ? path.dirname(fullKey) : "";
    const finalDir = dirName === "." ? "" : dirName;
    const savedFileName = req.file && req.file.filename;
    if (!savedFileName) {
      return res.status(400).json({ error: "Missing uploaded file" });
    }
    // 计算临时保存路径
    const tempKey = finalDir ? path.join(finalDir, savedFileName) : savedFileName;
    const tempPath = resolveSafePath(publicRoot, bucket, tempKey);

    // 计算扩展名（优先使用原始文件名的扩展名）
    const ext = path.extname((req.file && req.file.originalname) || fullKey || "");

    // 基于内容计算 sha256
    const sha256Hex = await computeFileSha256Hex(tempPath);
    const hashedName = `${sha256Hex}${ext}`;
    const finalKey = finalDir ? path.join(finalDir, hashedName) : hashedName;
    const finalPath = resolveSafePath(publicRoot, bucket, finalKey);

    // 如果同名（同哈希）文件已存在，删除临时文件并复用已存在文件
    try {
      await fs.promises.access(finalPath, fs.constants.F_OK);
      // 已存在 -> 删除临时
      await fs.promises.unlink(tempPath);
    } catch {
      // 不存在 -> 重命名到最终哈希路径
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      await fs.promises.rename(tempPath, finalPath);
    }

    const urlPath = `/public/${bucket}/${finalKey}`.replace(/\\/g, "/");
    return res.status(200).json({ bucket, key: finalKey, path: finalPath, url: urlPath, size: req.file && req.file.size, sha256: sha256Hex });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.put("/:bucket/:key(.*)", async (req, res) => {
  const bucket = req.params.bucket;
  const key = req.params.key || "";
  if (!key) {
    return res.status(400).json({ error: "Missing key" });
  }
  let outPath;
  try {
    outPath = resolveSafePath(publicRoot, bucket, key);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    const writeStream = fs.createWriteStream(outPath, { flags: "w" });
    req.pipe(writeStream);
    writeStream.on("finish", () => {
      const urlPath = `/public/${bucket}/${key}`.replace(/\\/g, "/");
      res.status(200).json({ bucket, key, path: outPath, url: urlPath });
    });
    writeStream.on("error", (err) => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`File server listening on http://localhost:${PORT}`);
});

