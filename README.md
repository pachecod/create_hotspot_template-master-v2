# VR Hotspots Educational Edition

A comprehensive VR Hotspot Editor with built-in student submission system for educational environments.

## 🎓 Educational Features

### For Students:
- **Full VR Editor**: Create immersive 360° experiences with hotspots
- **Easy Submission**: One-click project submission to admin
- **Professional Export**: Generate standalone VR experiences

### For Admins:
- **Automatic Collection**: All student projects automatically organized
- **Real-time Dashboard**: View submissions as they come in
- **Easy Access**: Download and review projects instantly

## 🚀 Quick Start

### 1. Setup (One Time)
```bash
# Install dependencies (includes A-Frame for offline support)
npm install

# Start the server
npm start
```

### 2. Offline Support ✨
- **Complete Offline Operation**: Works without internet connection
- **Local A-Frame**: VR libraries installed locally (no CDN required)
- **Self-Contained**: All assets and dependencies included
- **Perfect for Classrooms**: No internet connectivity required after setup

### 3. Access Points
- **Students**: http://localhost:3000 or open `index.html` directly
- **Admin Dashboard**: http://localhost:3000/admin-dashboard.html

### 4. Workflow
1. Students create VR projects using the editor
2. Students click "📤 Submit to Admin" when ready
3. Admin reviews submissions on the dashboard
4. Admin downloads projects for grading/hosting

## 📁 Project Structure

```
vr_hotspots/
├── index.html                    # Main VR editor interface
├── script.js                     # Complete editor functionality
├── style-editor.html            # Visual customization tool
├── simple-server.js             # Educational backend server
├── admin-dashboard.html         # Admin submission viewer
├── package.json                 # Node.js dependencies
├── student-projects/            # Submitted projects folder (auto-created)
├── hosted-projects/             # Hosted projects folder (auto-created)
├── EDUCATIONAL_SETUP.md         # Detailed setup guide
├── HOSTING_GUIDE.md             # Project hosting documentation
└── audio/, images/              # Asset folders
```

## 🎯 Core Features

### VR Editor:
- **Scene Management**: Multiple 360° environments
- **Hotspot Types**: Text, Audio, Text+Audio, Navigation, Weblink Portal (external URL)
- **Style Customization**: Visual theme editor
- **Export System**: Standalone project generation

### Educational Backend:
- **Project Collection**: Automatic ZIP file organization
- **Submission Tracking**: Metadata logging with timestamps
- **Admin Interface**: Clean dashboard for review
- **File Management**: Organized storage with student info

## 🛠 Technical Details

### Frontend:
- **A-Frame VR**: WebXR-compatible VR framework (v1.7.1 - local installation)
- **A-Frame Extras**: Additional VR components (v7.6.0 - local installation)  
- **Offline Ready**: No CDN dependencies, works without internet
- **Responsive Design**: Works on desktop, mobile, VR headsets
- **LocalStorage**: User preferences and temporary data
- **Export System**: Complete project bundling

### Backend:
- **Node.js/Express**: Lightweight web server
- **Multer**: File upload handling
- **JSON Logging**: Simple submission tracking
- **Static Serving**: Hosts the VR editor

## 📖 Documentation

- **[Educational Setup Guide](EDUCATIONAL_SETUP.md)**: Step-by-step installation and usage
- **[Hosting Guide](HOSTING_GUIDE.md)**: Student project hosting and deployment
- **[Copilot Instructions](.github/copilot-instructions.md)**: Complete project documentation

## 🎮 Usage Examples

### Student Workflow:
1. Open http://localhost:3000
2. Create hotspots by selecting type and clicking on 360° image
3. Add scenes, audio, and customize styles
4. Click "📤 Submit to Admin"
5. Fill in name, student ID, and project name
6. Submit automatically uploads complete project

### Admin Workflow:
1. Open admin dashboard
2. View real-time list of submissions
3. Download individual projects as ZIP files
4. Extract and open `index.html` to experience student work
5. Grade or host projects as needed

## 🔧 Customization

### For Different Classes:
- Modify submission form fields in `script.js`
- Customize dashboard layout in `admin-dashboard.html`
- Add authentication or grading features
- Integrate with LMS systems

### For Production:
- Deploy to cloud hosting (Heroku, AWS, DigitalOcean)
- Add SSL certificates
- Configure domain names
- Scale server resources

## 🆘 Troubleshooting

### Common Issues:
- **Port 3000 in use**: The server will automatically fall back to the next available port. Check the console to see which port was chosen.
- **Submissions not working**: Check server console for errors
- **Large files failing**: Increase multer file size limits
- **Dashboard not updating**: Refresh browser or check network

### Support:
1. Check `EDUCATIONAL_SETUP.md` for detailed troubleshooting
2. Monitor server console output for error messages
3. Verify all files are present and Node.js is installed
4. Test with small projects first before full deployment

## 🔮 Future Enhancements

### Phase 2 Features:
- **Auto-hosting**: Deploy student projects to live URLs
- **Authentication**: Student accounts and login system
- **Grading Interface**: Built-in rubrics and scoring
- **Analytics**: Usage tracking and engagement metrics

### Database Integration:
- Replace JSON logging with PostgreSQL/MongoDB
- Add user management and project versioning
- Enable collaboration and sharing features
- Store detailed submission analytics

## 📜 License

This project is designed for educational use. Feel free to modify and adapt for your specific classroom needs.

---

**Ready to start?** Follow the [Educational Setup Guide](EDUCATIONAL_SETUP.md) for detailed instructions!
