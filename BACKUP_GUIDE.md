# Backup & Restore Guide for Render Deployment

## Problem
When you redeploy your app on Render.com (or other platform-as-a-service providers), the filesystem is reset and all student-submitted VR projects stored in `student-projects/` and `hosted-projects/` are lost.

## Solution
We've added **Backup & Restore** functionality to the Admin Dashboard that allows you to:
1. Download all projects as a single ZIP file before redeployment
2. Restore all projects after redeployment

---

## 🔄 Workflow: Before & After Redeployment

### **BEFORE Redeployment**

1. Open the Admin Dashboard at: `https://your-app.onrender.com/admin-dashboard.html`
2. Look for the **"Backup & Restore"** section at the top
3. Click **"📥 Download All Projects"**
4. Wait for the backup ZIP file to download (filename will be like `vr-projects-backup-1729267800000.zip`)
5. **Save this file safely** on your local computer or cloud storage (Google Drive, Dropbox, etc.)

### **AFTER Redeployment**

1. Wait for Render to finish deploying your updated app
2. Open the Admin Dashboard again: `https://your-app.onrender.com/admin-dashboard.html`
3. Click **"📤 Restore from Backup"**
4. Select the backup ZIP file you downloaded earlier
5. Wait for the restore to complete (usually 30-60 seconds depending on project size)
6. All submissions, hosted projects, and metadata will be restored!

---

## 📦 What's Included in the Backup?

The backup ZIP contains:
- **`student-projects/`** - All original ZIP files submitted by students
- **`hosted-projects/`** - All live hosted VR projects (with their unique URLs)
- **`submissions.json`** - Metadata log (student names, timestamps, hosted URLs, etc.)

---

## ✅ Best Practices

### Regular Backups
- **Download a backup weekly** (or after every few submissions)
- Keep multiple backup versions with timestamps
- Store backups in a safe location (cloud storage recommended)

### Before Major Changes
Always download a backup before:
- Updating server code (`simple-server.js`)
- Modifying project structure
- Making configuration changes
- Any Render redeployment

### Testing
- Test the restore process on a local server before using in production
- Verify all projects and hosted URLs work after restore

---

## 🛠️ Technical Details

### API Endpoints

**Download Backup:**
```
GET /admin/backup-all
Response: ZIP file containing all projects
```

**Restore Backup:**
```
POST /admin/restore-backup
Body: multipart/form-data with 'backup' file
Response: { success: true, message: "Backup restored successfully!" }
```

### File Structure in Backup
```
vr-projects-backup-1729267800000.zip
├── student-projects/
│   ├── John_Doe_1729267500000.zip
│   ├── Jane_Smith_1729267600000.zip
│   └── ...
├── hosted-projects/
│   ├── john_doe_1729267500000/
│   │   ├── index.html
│   │   ├── script.js
│   │   ├── images/
│   │   └── audio/
│   └── ...
└── submissions.json
```

### Restore Process
1. Uploads the backup ZIP to the server
2. Extracts all files to their original locations
3. Overwrites any existing files (merged with current data)
4. Preserves folder structure and hosted project URLs

---

## ⚠️ Important Notes

### Data Merge (Not Replace)
- Restore **merges** data with existing files (doesn't wipe current data first)
- If you have duplicate filenames, older files may be overwritten
- For a clean restore, delete existing projects manually first (or use Render's clean deploy)

### File Size Limits
- Render has upload size limits (typically 500MB)
- If your backup exceeds this, consider:
  - Using external storage (S3, DigitalOcean Spaces)
  - Manually downloading/uploading individual projects
  - Archiving old projects separately

### Network Stability
- Large backups may take time to upload/restore
- Keep the browser tab open during restore
- Don't refresh or close the page until completion message appears

---

## 🚀 Advanced: Permanent Storage Solution

For a more robust solution without manual backups, consider:

### Option 1: Render Persistent Disk
- Mount a Render Persistent Disk to store `student-projects/` and `hosted-projects/`
- Data survives redeployments automatically
- Cost: ~$1/GB/month
- [Guide](https://render.com/docs/disks)

### Option 2: External Object Storage (S3/Spaces)
- Store all projects in AWS S3 or DigitalOcean Spaces
- Modify `simple-server.js` to upload/download from S3 instead of filesystem
- More complex but highly scalable
- See `HOSTING_GUIDE.md` for S3 integration details

---

## 📞 Support

If you encounter issues:
1. Check browser console for error messages
2. Verify the backup ZIP is not corrupted (try extracting it locally)
3. Ensure sufficient disk space on Render instance
4. Test restore process locally first: `npm start` then access `http://localhost:3000/admin-dashboard.html`

---

## Summary Checklist

**Before Every Redeployment:**
- [ ] Go to Admin Dashboard
- [ ] Click "Download All Projects"
- [ ] Save backup ZIP safely
- [ ] Deploy changes on Render

**After Redeployment:**
- [ ] Wait for deployment to complete
- [ ] Open Admin Dashboard
- [ ] Click "Restore from Backup"
- [ ] Select saved ZIP file
- [ ] Wait for success message
- [ ] Verify projects are accessible

---

**Remember:** The backup system is your safety net! Always download a backup before making changes.
