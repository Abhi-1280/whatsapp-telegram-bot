const { Storage } = require('megajs');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');

class SessionManager {
    constructor() {
        this.storage = new Storage({
            email: process.env.MEGA_EMAIL,
            password: process.env.MEGA_PASSWORD
        });
        this.sessionPath = './session';
        this.ready = false;
    }

    async init() {
        if (!this.ready) {
            await this.storage.login();
            this.ready = true;
        }
    }

    async uploadSession() {
        try {
            await this.init();
            
            // Create zip of session
            const zipPath = './session_backup.zip';
            await this.createZip(this.sessionPath, zipPath);
            
            // Upload to Mega
            const buffer = await fs.readFile(zipPath);
            const uploadStream = this.storage.upload({
                name: 'whatsapp_session.zip',
                size: buffer.length
            });
            
            uploadStream.write(buffer);
            uploadStream.end();
            
            await new Promise((resolve, reject) => {
                uploadStream.on('complete', resolve);
                uploadStream.on('error', reject);
            });
            
            // Clean up
            await fs.unlink(zipPath);
            console.log('Session uploaded to Mega successfully');
            
        } catch (error) {
            console.error('Error uploading session:', error);
        }
    }

    async downloadSession() {
        try {
            await this.init();
            
            // Find session file
            const files = await this.storage.root.children;
            const sessionFile = files.find(f => f.name === 'whatsapp_session.zip');
            
            if (!sessionFile) {
                console.log('No session backup found in Mega');
                return false;
            }
            
            // Download file
            const buffer = await sessionFile.downloadBuffer();
            const zipPath = './session_restore.zip';
            await fs.writeFile(zipPath, buffer);
            
            // Extract session
            await extract(zipPath, { dir: path.resolve('./') });
            
            // Clean up
            await fs.unlink(zipPath);
            console.log('Session restored from Mega successfully');
            return true;
            
        } catch (error) {
            console.error('Error downloading session:', error);
            return false;
        }
    }

    async createZip(sourceDir, outPath) {
        const output = require('fs').createWriteStream(outPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        return new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            
            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }
}

module.exports = SessionManager;