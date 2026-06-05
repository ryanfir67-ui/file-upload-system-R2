export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS Headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Halaman utama
    if (path === '/' && method === 'GET') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Upload file dengan chunking untuk file besar
    if (path === '/upload' && method === 'POST') {
      try {
        const contentType = request.headers.get('Content-Type') || '';
        
        // Handle multipart form data
        if (contentType.includes('multipart/form-data')) {
          const formData = await request.formData();
          const file = formData.get('file');
          
          if (!file) {
            return new Response(JSON.stringify({ error: 'No file uploaded' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Validasi ukuran file (maks 10 GB)
          const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
          if (file.size > MAX_SIZE) {
            return new Response(JSON.stringify({ error: 'File too large. Max 10GB' }), {
              status: 413,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const fileName = `${Date.now()}-${file.name}`;
          const fileBuffer = await file.arrayBuffer();
          
          // Upload ke R2
          await env.MY_BUCKET.put(fileName, fileBuffer, {
            httpMetadata: {
              contentType: file.type || 'application/octet-stream',
              contentDisposition: `attachment; filename="${encodeURIComponent(file.name)}"`,
            },
          });

          return new Response(JSON.stringify({ 
            success: true, 
            fileName: fileName,
            originalName: file.name,
            size: file.size,
            url: `/download/${fileName}`
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify({ error: 'Invalid content type' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Upload dengan chunking (untuk file > 100MB)
    if (path === '/upload-chunk' && method === 'POST') {
      try {
        const { chunk, fileName, chunkIndex, totalChunks, originalName } = await request.json();
        
        const chunkKey = `chunks/${fileName}/chunk_${chunkIndex}`;
        await env.MY_BUCKET.put(chunkKey, base64ToArrayBuffer(chunk));
        
        // Cek apakah semua chunk sudah terupload
        const uploadedChunks = [];
        for (let i = 0; i < totalChunks; i++) {
          const chunkExists = await env.MY_BUCKET.head(`chunks/${fileName}/chunk_${i}`);
          if (chunkExists) uploadedChunks.push(i);
        }
        
        if (uploadedChunks.length === totalChunks) {
          // Gabungkan semua chunk
          const chunks = [];
          for (let i = 0; i < totalChunks; i++) {
            const chunkData = await env.MY_BUCKET.get(`chunks/${fileName}/chunk_${i}`);
            const chunkBuffer = await chunkData.arrayBuffer();
            chunks.push(chunkBuffer);
          }
          
          // Gabungkan menjadi satu file
          const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const mergedFile = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            mergedFile.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }
          
          // Simpan file final
          await env.MY_BUCKET.put(fileName, mergedFile, {
            httpMetadata: {
              contentType: 'application/octet-stream',
              contentDisposition: `attachment; filename="${encodeURIComponent(originalName)}"`,
            },
          });
          
          // Hapus chunk
          for (let i = 0; i < totalChunks; i++) {
            await env.MY_BUCKET.delete(`chunks/${fileName}/chunk_${i}`);
          }
          
          return new Response(JSON.stringify({ 
            success: true, 
            fileName: fileName,
            originalName: originalName 
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          chunkIndex: chunkIndex,
          uploaded: uploadedChunks.length,
          total: totalChunks 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Download file
    if (path.startsWith('/download/') && method === 'GET') {
      const fileName = path.split('/download/')[1];
      
      try {
        const object = await env.MY_BUCKET.get(fileName);
        
        if (!object) {
          return new Response('File not found', { status: 404 });
        }
        
        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', object.httpMetadata.contentDisposition || `attachment; filename="${fileName}"`);
        headers.set('Content-Length', object.size);
        headers.set('Accept-Ranges', 'bytes');
        
        // Support range requests untuk resume download
        const range = request.headers.get('Range');
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : object.size - 1;
          const chunksize = (end - start) + 1;
          
          const chunk = await object.slice(start, end + 1);
          headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
          headers.set('Content-Length', chunksize);
          
          return new Response(chunk.body, {
            status: 206,
            headers: headers,
          });
        }
        
        return new Response(object.body, { headers });
      } catch (error) {
        return new Response('Error: ' + error.message, { status: 500 });
      }
    }

    // List files
    if (path === '/files' && method === 'GET') {
      const objects = await env.MY_BUCKET.list();
      const files = await Promise.all(
        objects.objects.map(async (obj) => {
          const head = await env.MY_BUCKET.head(obj.key);
          return {
            name: obj.key,
            size: obj.size,
            uploaded: obj.uploaded,
            type: head?.httpMetadata?.contentType || 'unknown',
          };
        })
      );
      
      return new Response(JSON.stringify(files), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Delete file
    if (path.startsWith('/delete/') && method === 'DELETE') {
      const fileName = path.split('/delete/')[1];
      await env.MY_BUCKET.delete(fileName);
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Upload System - Cloudflare R2 (Max 10GB)</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .card {
            background: white;
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        
        h1 {
            color: #333;
            margin-bottom: 10px;
        }
        
        .subtitle {
            color: #666;
            margin-bottom: 30px;
        }
        
        .upload-area {
            border: 3px dashed #667eea;
            border-radius: 15px;
            padding: 50px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s ease;
            background: #f8f9ff;
        }
        
        .upload-area:hover, .upload-area.drag-over {
            border-color: #764ba2;
            background: #f0e6ff;
        }
        
        .upload-icon {
            font-size: 48px;
            margin-bottom: 15px;
        }
        
        .file-input {
            display: none;
        }
        
        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 16px;
            margin: 10px 5px;
            transition: transform 0.2s;
        }
        
        .btn:hover {
            transform: translateY(-2px);
        }
        
        .btn-danger {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }
        
        .progress-container {
            margin: 20px 0;
            display: none;
        }
        
        .progress-bar {
            width: 100%;
            height: 30px;
            background: #e0e0e0;
            border-radius: 15px;
            overflow: hidden;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            width: 0%;
            transition: width 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }
        
        .file-list {
            margin-top: 20px;
        }
        
        .file-item {
            background: #f5f5f5;
            padding: 15px;
            margin: 10px 0;
            border-radius: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
        }
        
        .file-info {
            flex: 1;
        }
        
        .file-name {
            font-weight: bold;
            color: #333;
        }
        
        .file-size {
            font-size: 12px;
            color: #666;
            margin-left: 10px;
        }
        
        .file-actions {
            margin-top: 10px;
        }
        
        .btn-small {
            padding: 5px 15px;
            font-size: 12px;
            margin: 0 5px;
        }
        
        .status {
            margin-top: 20px;
            padding: 15px;
            border-radius: 10px;
            display: none;
        }
        
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        @media (max-width: 768px) {
            .file-item {
                flex-direction: column;
                align-items: flex-start;
            }
            
            .file-actions {
                margin-top: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>🚀 File Upload System</h1>
            <p class="subtitle">Support file up to <strong>10 GB</strong> dengan Cloudflare R2</p>
            
            <div class="upload-area" id="uploadArea">
                <div class="upload-icon">📁</div>
                <p>Click or drag file here to upload</p>
                <p style="font-size: 12px; color: #666; margin-top: 10px;">Maximum file size: 10 GB</p>
                <input type="file" id="fileInput" class="file-input">
            </div>
            
            <div class="progress-container" id="progressContainer">
                <div class="progress-bar">
                    <div class="progress-fill" id="progressFill">0%</div>
                </div>
                <p id="uploadStatus" style="margin-top: 10px; text-align: center;"></p>
            </div>
            
            <div class="status" id="status"></div>
        </div>
        
        <div class="card">
            <h2>📋 Uploaded Files</h2>
            <button class="btn" onclick="loadFiles()">🔄 Refresh</button>
            <div class="file-list" id="fileList">
                <p>Loading files...</p>
            </div>
        </div>
    </div>
    
    <script>
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const uploadStatus = document.getElementById('uploadStatus');
        const statusDiv = document.getElementById('status');
        
        const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
        const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per chunk
        
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('drag-over');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
        });
        
        fileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) handleFile(e.target.files[0]);
        });
        
        async function handleFile(file) {
            if (file.size > MAX_SIZE) {
                showStatus('File too large! Maximum size is 10 GB.', 'error');
                return;
            }
            
            showStatus(\`Uploading \${file.name} (\${formatBytes(file.size)})...\`, 'success');
            progressContainer.style.display = 'block';
            
            // Gunakan chunking untuk file > 100 MB
            if (file.size > 100 * 1024 * 1024) {
                await uploadWithChunks(file);
            } else {
                await uploadDirect(file);
            }
        }
        
        async function uploadDirect(file) {
            const formData = new FormData();
            formData.append('file', file);
            
            try {
                const response = await fetch('/upload', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showStatus(\`✅ Upload successful: \${result.originalName}\`, 'success');
                    loadFiles();
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                showStatus(\`❌ Upload failed: \${error.message}\`, 'error');
            } finally {
                progressContainer.style.display = 'none';
                progressFill.style.width = '0%';
                progressFill.textContent = '0%';
            }
        }
        
        async function uploadWithChunks(file) {
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const fileName = \`\${Date.now()}-\${file.name}\`;
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);
                
                const progress = ((i + 1) / totalChunks) * 100;
                progressFill.style.width = progress + '%';
                progressFill.textContent = Math.round(progress) + '%';
                uploadStatus.textContent = \`Uploading chunk \${i + 1} of \${totalChunks} (\${formatBytes(chunk.size)})\`;
                
                const base64Chunk = await chunkToBase64(chunk);
                
                const response = await fetch('/upload-chunk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chunk: base64Chunk,
                        fileName: fileName,
                        chunkIndex: i,
                        totalChunks: totalChunks,
                        originalName: file.name
                    })
                });
                
                const result = await response.json();
                
                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Chunk upload failed');
                }
            }
            
            showStatus(\`✅ Large file uploaded successfully: \${file.name}\`, 'success');
            loadFiles();
            progressContainer.style.display = 'none';
            progressFill.style.width = '0%';
            progressFill.textContent = '0%';
            uploadStatus.textContent = '';
        }
        
        function chunkToBase64(chunk) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(chunk);
            });
        }
        
        async function loadFiles() {
            try {
                const response = await fetch('/files');
                const files = await response.json();
                const fileList = document.getElementById('fileList');
                
                if (files.length === 0) {
                    fileList.innerHTML = '<p>No files uploaded yet.</p>';
                    return;
                }
                
                fileList.innerHTML = files.map(file => \`
                    <div class="file-item">
                        <div class="file-info">
                            <span class="file-name">\${escapeHtml(file.name)}</span>
                            <span class="file-size">(\${formatBytes(file.size)})</span>
                            <div class="file-actions">
                                <button class="btn btn-small" onclick="downloadFile('\${file.name}')">⬇️ Download</button>
                                <button class="btn btn-small btn-danger" onclick="deleteFile('\${file.name}')">🗑️ Delete</button>
                            </div>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Error loading files:', error);
            }
        }
        
        async function downloadFile(fileName) {
            window.location.href = \`/download/\${fileName}\`;
        }
        
        async function deleteFile(fileName) {
            if (confirm(\`Are you sure you want to delete \${fileName}?\`)) {
                try {
                    const response = await fetch(\`/delete/\${fileName}\`, {
                        method: 'DELETE'
                    });
                    
                    if (response.ok) {
                        showStatus(\`✅ \${fileName} deleted successfully\`, 'success');
                        loadFiles();
                    } else {
                        throw new Error('Delete failed');
                    }
                } catch (error) {
                    showStatus(\`❌ Delete failed: \${error.message}\`, 'error');
                }
            }
        }
        
        function showStatus(message, type) {
            statusDiv.textContent = message;
            statusDiv.className = \`status \${type}\`;
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }
        
        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
        
        // Load files on page load
        loadFiles();
    </script>
</body>
</html>`;
}
}