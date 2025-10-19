# Educational Backend Setup Guide

## Quick Setup (5 minutes)

### 1. Install Node.js
- Download from https://nodejs.org
- Install the LTS version
- Verify installation: `node --version`

### 2. Setup the Server
```bash
# In the vr_hotspots folder, open PowerShell/Terminal and run:
npm install

# Start the server
npm start
```

### 3. Access the Application
- **Students**: http://localhost:3000 (main VR editor)
- **Admin**: http://localhost:3000/admin-dashboard.html

## How It Works

### For Students:
1. Open the VR editor at http://localhost:3000
2. Create their VR hotspot project normally
3. Click "📤 Submit to Admin" in the right panel
4. Fill in their name, student ID, and project name
5. Click submit - project automatically uploaded to server
6. Optional: Open the "🎨 Customize Styles" tool, Save & Return — scenes and styles persist

### For Admin:
1. Open http://localhost:3000/admin-dashboard.html
2. View all student submissions with timestamps
3. Download individual projects as ZIP files
4. Host projects with custom URLs for public access
5. Extract and open `index.html` to view student work

## Server Features

### Automatic Organization:
- Projects saved as: `{studentID}_{projectName}_{timestamp}.zip`
- All submissions logged with metadata
- Real-time dashboard updates

### File Structure Created:
```
vr_hotspots/
├── student-projects/          # All submitted ZIP files
├── hosted-projects/           # Auto-hosted student projects
├── submissions.json           # Log of all submissions
├── simple-server.js          # Server code
├── admin-dashboard.html      # Admin interface
└── package.json              # Dependencies
```

## Production Deployment

### Option 1: Local Network (Classroom)
```bash
# Find your IP address
ipconfig

# Students access via: http://YOUR_IP:3000
# Example: http://192.168.1.100:3000
```

### Option 2: Cloud Hosting (Recommended)
- Deploy to Heroku, DigitalOcean, or AWS
- Add HTTPS certificate
- Configure domain name
- Scale as needed

## Troubleshooting

### Common Issues:

**"Server not running" error:**
- Make sure you ran `npm start`
- Check if port 3000 is available
- Try restarting the server

**Submissions not appearing:**
- Refresh the admin dashboard
- Check if `student-projects` folder exists
- Verify server console for errors

**Large file uploads failing:**
- Check browser upload limits
- Consider compressing project images
- Monitor server disk space

**Editor state lost after visiting Style Editor:**
- Fixed in current version. The editor saves scenes to `localStorage` key `vr-hotspot-scenes-data` and styles to `vr-hotspot-css-styles` before navigating, then restores them on return.
- Use the "Clear Data" button only when you want to intentionally reset localStorage.

### Security Notes:
- This is a basic educational server
- For production, add authentication
- Consider file size limits
- Add input validation

## Support

### Getting Help:
1. Check the console output for error messages
2. Ensure all required files are present
3. Verify Node.js and npm are properly installed
4. Check firewall settings for port 3000

### Next Steps:
- Test with a few students first
- Plan backup strategy for submissions
- Consider automated deployment for final projects
- Explore integration with learning management systems
