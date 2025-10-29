// Educational backend server for VR Hotspots

const express = require("express");
const multer = require("multer");
const path = require("path");
const https = require("https");
const fs = require("fs");
const unzipper = require("unzipper");
const archiver = require("archiver");

const app = express();
const upload = multer({ dest: "student-projects/" });

// Serve the VR editor with cache-busting headers so students always get updates
const staticNoStaleOptions = {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    // Never cache HTML; always fetch latest shell
    if (ext === ".html" || ext === ".htm") {
      res.setHeader("Cache-Control", "no-store");
      return;
    }
    // For app code and configs, force revalidation each load
    if (ext === ".js" || ext === ".css" || ext === ".json") {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return;
    }
    // Media and images: revalidate so changed files get fetched without manual clears
    if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".mp3", ".wav", ".ogg", ".mp4", ".webm"].includes(ext)) {
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
      return;
    }
    // Default: conservative no-cache
    res.setHeader("Cache-Control", "no-cache");
  }
};
app.use(express.static(".", staticNoStaleOptions));
app.use(express.json());

// Serve hosted student projects with the same anti-stale headers
app.use("/hosted", express.static("hosted-projects", staticNoStaleOptions));

// Collect student project submissions
app.post("/submit-project", upload.single("project"), (req, res) => {
  const { studentName, projectName } = req.body;
  const projectFile = req.file;

  // Rename and organize the file
  const fileName = `${studentName.replace(
    /[^a-zA-Z0-9]/g,
    "_"
  )}_${Date.now()}.zip`;
  const finalPath = path.join("student-projects", fileName);

  fs.renameSync(projectFile.path, finalPath);

  // Log submission
  const submission = {
    studentName,
    projectName,
    fileName,
    submittedAt: new Date().toISOString(),
  };

  // Save to log file
  fs.appendFileSync("submissions.json", JSON.stringify(submission) + "\n");

  res.json({
    success: true,
    message: "Project submitted successfully!",
    fileName,
  });
});

// Server-side video fetch endpoint (bypasses CORS)
app.post("/fetch-video", express.json(), async (req, res) => {
  const { url } = req.body;

  // Validate URL
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ 
      success: false, 
      error: "Invalid URL. Must be http or https." 
    });
  }

  // Prevent localhost/private IP abuse
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    if (hostname === "localhost" || 
        hostname === "127.0.0.1" || 
        hostname.startsWith("192.168.") || 
        hostname.startsWith("10.") || 
        hostname.startsWith("172.")) {
      return res.status(403).json({ 
        success: false, 
        error: "Cannot fetch from private/local addresses." 
      });
    }
  } catch (e) {
    return res.status(400).json({ 
      success: false, 
      error: "Invalid URL format." 
    });
  }

  console.log(`📹 Fetching video from: ${url}`);

  const protocol = url.startsWith("https") ? https : require("http");

  protocol.get(url, { timeout: 60000 }, (videoRes) => {
    // Check response status
    if (videoRes.statusCode !== 200) {
      return res.status(videoRes.statusCode).json({ 
        success: false, 
        error: `Remote server returned ${videoRes.statusCode}` 
      });
    }

    // Set headers
    const contentType = videoRes.headers["content-type"] || "video/mp4";
    const contentLength = videoRes.headers["content-length"];

    // Check file size (limit to 500MB)
    if (contentLength && parseInt(contentLength) > 500 * 1024 * 1024) {
      videoRes.destroy();
      return res.status(413).json({ 
        success: false, 
        error: "Video file too large (max 500MB)." 
      });
    }

    res.setHeader("Content-Type", contentType);
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Stream video directly to client
    videoRes.pipe(res);

    videoRes.on("error", (err) => {
      console.error("Video fetch error:", err);
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false, 
          error: "Failed to fetch video." 
        });
      }
    });

  }).on("error", (err) => {
    console.error("Video fetch error:", err);
    res.status(500).json({ 
      success: false, 
      error: `Network error: ${err.message}` 
    });
  });
});

// Admin can view all submissions (API endpoint)
app.get("/admin/submissions", (req, res) => {
  try {
    const logs = fs
      .readFileSync("submissions.json", "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    res.json(logs);
  } catch (error) {
    res.json([]);
  }
});

// Admin can download individual projects
app.get("/admin/download/:filename", (req, res) => {
  try {
    const filePath = path.join("student-projects", req.params.filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Set proper headers for download
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.filename}"`
    );
    res.setHeader("Content-Type", "application/zip");

    res.download(filePath, req.params.filename, (err) => {
      if (err) {
        console.error("Download error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Download failed" });
        }
      }
    });
  } catch (error) {
    console.error("Download endpoint error:", error);
    res.status(500).json({ error: "Server error during download" });
  }
});

// Admin can delete individual projects
app.delete("/admin/delete/:filename", (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join("student-projects", filename);

    // Delete the ZIP file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Find and delete any hosted project folder for this submission
    if (fs.existsSync("submissions.json")) {
      const logs = fs
        .readFileSync("submissions.json", "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      const submission = logs.find((sub) => sub.fileName === filename);

      // If this project was hosted, delete the hosted folder
      if (submission) {
        let hostedPath = submission.hostedPath;

        // Handle legacy format where only hostedUrl exists
        if (!hostedPath && submission.hostedUrl) {
          const urlMatch = submission.hostedUrl.match(/\/hosted\/([^\/]+)\//);
          if (urlMatch) {
            hostedPath = urlMatch[1];
          }
        }

        if (hostedPath) {
          const hostedDir = path.join("hosted-projects", hostedPath);
          if (fs.existsSync(hostedDir)) {
            fs.rmSync(hostedDir, { recursive: true, force: true });
            console.log(`Deleted hosted folder: ${hostedDir}`);
          }
        }
      }

      // Remove from submissions log
      const updatedLogs = logs.filter(
        (submission) => submission.fileName !== filename
      );

      // Rewrite the log file
      fs.writeFileSync(
        "submissions.json",
        updatedLogs.map((log) => JSON.stringify(log)).join("\n") +
          (updatedLogs.length > 0 ? "\n" : "")
      );
    }

    res.json({
      success: true,
      message: "Project and hosted files deleted successfully",
    });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting project: " + error.message,
    });
  }
});

// Admin can host individual projects
app.post("/admin/host/:filename", (req, res) => {
  try {
    const filename = req.params.filename;
    const { urlPath } = req.body;

    if (!urlPath || !/^[a-zA-Z0-9_-]+$/.test(urlPath)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid URL path. Use only letters, numbers, underscores, and hyphens.",
      });
    }

    const filePath = path.join("student-projects", filename);
    const hostedDir = path.join("hosted-projects", urlPath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Project file not found",
      });
    }

    // Check if project is already hosted somewhere else and remove it
    if (fs.existsSync("submissions.json")) {
      const logs = fs
        .readFileSync("submissions.json", "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      const existingSubmission = logs.find((sub) => sub.fileName === filename);
      if (
        existingSubmission &&
        existingSubmission.hostedPath &&
        existingSubmission.hostedPath !== urlPath
      ) {
        // Remove old hosted version
        const oldHostedDir = path.join(
          "hosted-projects",
          existingSubmission.hostedPath
        );
        if (fs.existsSync(oldHostedDir)) {
          fs.rmSync(oldHostedDir, { recursive: true, force: true });
          console.log(
            `Removed old hosted version at: ${existingSubmission.hostedPath}`
          );
        }
      }
    }

    // Create hosted-projects directory if it doesn't exist
    if (!fs.existsSync("hosted-projects")) {
      fs.mkdirSync("hosted-projects");
    }

    // Remove existing hosted version if it exists (in case URL path is being reused)
    if (fs.existsSync(hostedDir)) {
      fs.rmSync(hostedDir, { recursive: true, force: true });
    }

    // Create directory for this hosted project
    fs.mkdirSync(hostedDir, { recursive: true });

    // Extract ZIP to hosted directory
    fs.createReadStream(filePath)
      .pipe(unzipper.Extract({ path: hostedDir }))
      .on("close", () => {
        // Update submissions log with hosted URL and path
        if (fs.existsSync("submissions.json")) {
          const logs = fs
            .readFileSync("submissions.json", "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => {
              const submission = JSON.parse(line);
              if (submission.fileName === filename) {
                submission.hostedUrl = `/hosted/${urlPath}/index.html`;
                submission.hostedPath = urlPath;
                submission.hostedAt = new Date().toISOString();
                submission.isHosted = true;
              }
              return JSON.stringify(submission);
            });

          fs.writeFileSync("submissions.json", logs.join("\n") + "\n");
        }

        const hostedUrl = `${req.protocol}://${req.get(
          "host"
        )}/hosted/${urlPath}/index.html`;
        res.json({
          success: true,
          message: "Project hosted successfully!",
          hostedUrl: hostedUrl,
          urlPath: urlPath,
        });
      })
      .on("error", (error) => {
        console.error("Extract error:", error);
        res.status(500).json({
          success: false,
          message: "Error extracting project: " + error.message,
        });
      });
  } catch (error) {
    console.error("Host endpoint error:", error);
    res.status(500).json({
      success: false,
      message: "Error hosting project: " + error.message,
    });
  }
});

// Admin can unhost individual projects
app.post("/admin/unhost/:filename", (req, res) => {
  try {
    const filename = req.params.filename;

    // Find the project in submissions log to get hosted path
    if (fs.existsSync("submissions.json")) {
      const logs = fs
        .readFileSync("submissions.json", "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      const submission = logs.find((sub) => sub.fileName === filename);

      if (!submission || (!submission.hostedPath && !submission.hostedUrl)) {
        return res.status(404).json({
          success: false,
          message: "Project is not currently hosted",
        });
      }

      let hostedPath = submission.hostedPath;

      // Handle legacy format where only hostedUrl exists
      if (!hostedPath && submission.hostedUrl) {
        // Extract path from URL like "/hosted/sagarg/index.html" -> "sagarg"
        const urlMatch = submission.hostedUrl.match(/\/hosted\/([^\/]+)\//);
        if (urlMatch) {
          hostedPath = urlMatch[1];
        }
      }

      if (!hostedPath) {
        return res.status(404).json({
          success: false,
          message: "Could not determine hosted path",
        });
      }

      // Remove hosted directory
      const hostedDir = path.join("hosted-projects", hostedPath);
      if (fs.existsSync(hostedDir)) {
        fs.rmSync(hostedDir, { recursive: true, force: true });
      }

      // Update submissions log to remove hosting info
      const updatedLogs = logs.map((line) => {
        const sub = JSON.parse(JSON.stringify(line));
        if (sub.fileName === filename) {
          delete sub.hostedUrl;
          delete sub.hostedPath;
          delete sub.hostedAt;
          sub.isHosted = false;
        }
        return JSON.stringify(sub);
      });

      fs.writeFileSync("submissions.json", updatedLogs.join("\n") + "\n");

      res.json({
        success: true,
        message: "Project unhosted successfully!",
      });
    } else {
      res.status(404).json({
        success: false,
        message: "No submissions found",
      });
    }
  } catch (error) {
    console.error("Unhost endpoint error:", error);
    res.status(500).json({
      success: false,
      message: "Error unhosting project: " + error.message,
    });
  }
});

// Admin: Download ALL projects as a single backup ZIP
app.get("/admin/backup-all", (req, res) => {
  try {
    const archive = archiver("zip", { zlib: { level: 9 } });

    // Set response headers
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="vr-projects-backup-${Date.now()}.zip"`
    );

    // Pipe archive to response
    archive.pipe(res);

    // Add all student projects
    const projectsDir = "student-projects";
    if (fs.existsSync(projectsDir)) {
      const files = fs.readdirSync(projectsDir);
      files.forEach((file) => {
        const filePath = path.join(projectsDir, file);
        if (fs.statSync(filePath).isFile()) {
          archive.file(filePath, { name: `student-projects/${file}` });
        }
      });
    }

    // Add submissions.json if it exists
    if (fs.existsSync("submissions.json")) {
      archive.file("submissions.json", { name: "submissions.json" });
    }

    // Add hosted projects
    const hostedDir = "hosted-projects";
    if (fs.existsSync(hostedDir)) {
      archive.directory(hostedDir, "hosted-projects");
    }

    // Finalize the archive
    archive.finalize();

    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Failed to create backup" });
    });

    console.log("📦 Creating backup of all projects...");
  } catch (error) {
    console.error("Backup error:", error);
    res.status(500).json({ error: "Backup failed" });
  }
});

// Admin: Restore projects from backup ZIP
app.post("/admin/restore-backup", upload.single("backup"), async (req, res) => {
  try {
    const backupFile = req.file;
    if (!backupFile) {
      return res.status(400).json({ error: "No backup file provided" });
    }

    console.log("📥 Restoring backup...");

    // Extract the backup ZIP
    await fs
      .createReadStream(backupFile.path)
      .pipe(unzipper.Extract({ path: "." }))
      .promise();

    // Remove the temporary upload file
    fs.unlinkSync(backupFile.path);

    console.log("✅ Backup restored successfully!");

    res.json({
      success: true,
      message: "Backup restored successfully!",
    });
  } catch (error) {
    console.error("Restore error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to restore backup: " + error.message,
    });
  }
});

// Determine if we should use HTTPS (only for local development with certificates)
const useHTTPS =
  fs.existsSync("localhost+1-key.pem") && fs.existsSync("localhost+1.pem");

// Use environment port or fallback to 3000
const PORT = process.env.PORT || 3000;

if (useHTTPS) {
  // Local HTTPS setup with mkcert certificates
  const options = {
    key: fs.readFileSync("localhost+1-key.pem"),
    cert: fs.readFileSync("localhost+1.pem"),
  };

  https.createServer(options, app).listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Server running on https://localhost:${PORT}`);
    console.log(`🌐 Also accessible at https://192.168.1.80:${PORT}`);
    console.log(
      `👨‍💼 Admin dashboard: https://localhost:${PORT}/admin-dashboard.html`
    );
  });
} else {
  // Production HTTP setup (e.g., Render, Heroku)
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log(
      `👨‍🏫 Professor dashboard: http://localhost:${PORT}/professor-dashboard.html`
    );
    console.log("ℹ️  Running in HTTP mode (no SSL certificates found)");
  });
}
