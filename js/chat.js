document.addEventListener('DOMContentLoaded', () => {
    // --- Socket.IO Connection ---
    const socket = io({
        // Auto connect is default. Options can be added here.
        // e.g., transports: ['websocket'], // Force websocket transport
        // auth: { token: 'your_jwt_token' } // Example if using token auth
    });

    // --- DOM Elements ---
    const messagesContainer = document.getElementById('messages');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const sendButton = messageForm.querySelector('.send-button');
    const userNicknameSpan = document.getElementById('user-nickname');
    const userCodeSpan = document.getElementById('user-code');
    const userAvatarImg = document.getElementById('user-avatar');

    // --- State ---
    let currentUser = null; // To store {nickname, userCode, avatarUrl}

    // --- Helper Functions ---

    function scrollToBottom(force = false) {
        const shouldScroll = force || (messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 100); // Check if user is near the bottom
        if (shouldScroll) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    function formatTimestamp(dateString) {
        try {
            const date = new Date(dateString);
             // Use Intl for better locale formatting if needed, otherwise keep simple
             return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
        } catch(e) {
            console.error("Error formatting timestamp:", e);
            return '--:--';
        }
    }

    // Basic HTML sanitization (consider a library like DOMPurify for robust sanitization)
    function sanitizeHTML(str) {
        if (typeof str !== 'string') return '';
        const temp = document.createElement('div');
        temp.textContent = str;
        return temp.innerHTML.replace(/</g, "&lt;").replace(/>/g, "&gt;"); // Basic entity encoding
    }

    // --- Message Display Functions ---

    function displayMessage(data) {
        if (!currentUser || !data || typeof data !== 'object') return; // Basic validation

        const isMyMessage = data.userCode === currentUser.userCode;
        const messageWrapper = document.createElement('div');
        messageWrapper.classList.add('message');
        messageWrapper.classList.add(isMyMessage ? 'my-message' : 'other-message');

        // Determine avatar source
        const avatarName = sanitizeHTML(data.nickname || '?').charAt(0).toUpperCase();
        const avatarSrc = data.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(avatarName)}&background=random&color=fff&size=30`;

        // Create elements dynamically for better control and security
        const avatarImg = document.createElement('img');
        avatarImg.src = avatarSrc; // Set src directly, assuming URL is safe or sanitized server-side
        avatarImg.alt = sanitizeHTML(data.nickname || '?');
        avatarImg.classList.add('avatar');

        const contentContainer = document.createElement('div');
        contentContainer.classList.add('content-container');

        const metaDiv = document.createElement('div');
        metaDiv.classList.add('meta');
        if (!isMyMessage) {
            const nicknameSpan = document.createElement('span');
            nicknameSpan.classList.add('nickname');
            nicknameSpan.textContent = sanitizeHTML(data.nickname); // Sanitize nickname
            metaDiv.appendChild(nicknameSpan);
        }
        const timestampSpan = document.createElement('span');
        timestampSpan.classList.add('timestamp');
        timestampSpan.textContent = formatTimestamp(data.timestamp);
        metaDiv.appendChild(timestampSpan);


        const textDiv = document.createElement('div');
        textDiv.classList.add('text');
        // Basic link detection (replace with a more robust solution if needed)
        const linkifiedText = sanitizeHTML(data.message).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
        textDiv.innerHTML = linkifiedText; // Use innerHTML carefully after sanitization/linkification

        contentContainer.appendChild(metaDiv);
        contentContainer.appendChild(textDiv);

        // Append avatar and content based on message direction
        if (isMyMessage) {
            messageWrapper.appendChild(contentContainer);
            messageWrapper.appendChild(avatarImg);
        } else {
            messageWrapper.appendChild(avatarImg);
            messageWrapper.appendChild(contentContainer);
        }

        messagesContainer.appendChild(messageWrapper);
        scrollToBottom(); // Scroll down after adding message
    }

    function displaySystemMessage(message) {
         const item = document.createElement('div');
         item.classList.add('message', 'system-message');
         const textDiv = document.createElement('div');
         textDiv.classList.add('text');
         textDiv.textContent = sanitizeHTML(message); // Sanitize system message too
         item.appendChild(textDiv);
         messagesContainer.appendChild(item);
         scrollToBottom(true); // Force scroll for system messages
    }

    // --- Initialization and User Info Fetching ---

    function initializeChatInterface() {
        // Fetch current user info from the backend API
        fetch('/api/user/me')
            .then(response => {
                if (!response.ok) {
                    // If unauthorized (e.g., session expired), redirect to login
                    if (response.status === 401 || response.status === 404) {
                         console.warn('User not authenticated or session expired. Redirecting...');
                         window.location.href = '/';
                    }
                    throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`);
                }
                return response.json();
            })
            .then(user => {
                // Basic validation of received user data
                if (!user || !user.nickname || !user.userCode) {
                     console.error('Incomplete user data received:', user);
                     // Possibly redirect to setup or login if critical info is missing
                     window.location.href = user.isNicknameSet === false ? '/setup' : '/';
                     return;
                }

                // Store user data
                currentUser = user;

                // Update UI with user info
                userNicknameSpan.textContent = sanitizeHTML(user.nickname);
                userCodeSpan.textContent = sanitizeHTML(user.userCode);
                if (user.avatarUrl) {
                    userAvatarImg.src = user.avatarUrl; // Assuming URL is safe
                    userAvatarImg.style.display = 'inline-block';
                } else {
                     userAvatarImg.style.display = 'none'; // Hide if no avatar
                }

                // Enable chat input now that user info is loaded
                messageInput.disabled = false;
                sendButton.disabled = false;
                messageInput.placeholder = `以 ${sanitizeHTML(user.nickname)} 的身份發言...`;
                messageInput.focus();

            })
            .catch(error => {
                console.error('Error initializing chat interface:', error);
                displaySystemMessage('無法載入您的使用者資訊，請嘗試重新整理頁面。');
                // Keep chat disabled on error
                messageInput.disabled = true;
                sendButton.disabled = true;
            });
    }

    // --- Socket.IO Event Listeners ---

    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        // Remove initial "connecting" message if it exists
        const connectingMsg = messagesContainer.querySelector('.system-message');
        if(connectingMsg && connectingMsg.textContent.includes('連接中')) {
            connectingMsg.remove();
        }
        displaySystemMessage('成功連接到聊天室！');
        // Fetch user info only after successful connection
        initializeChatInterface();
    });

    socket.on('disconnect', (reason) => {
        console.warn('Socket disconnected:', reason);
        displaySystemMessage(`連線中斷 (${reason})。正在嘗試重新連接...`);
        messageInput.disabled = true;
        sendButton.disabled = true;
        userNicknameSpan.textContent = '已斷線';
        userCodeSpan.textContent = '---';
        currentUser = null; // Clear user data on disconnect
    });

    socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err);
        displaySystemMessage(`無法連接到伺服器: ${err.message}. 請檢查網路連線。`);
    });

    // Listen for incoming chat messages from the server
    socket.on('chat message', (data) => {
        displayMessage(data);
    });

    // --- Form Submission Logic ---

    if (messageForm && messageInput && sendButton) {
        messageForm.addEventListener('submit', (event) => {
            event.preventDefault(); // Prevent page reload

            const message = messageInput.value.trim();

            // Check if connected, user data is loaded, and message is not empty
            if (socket.connected && currentUser && message) {
                // Emit the 'chat message' event to the server
                socket.emit('chat message', message);
                messageInput.value = ''; // Clear the input field
                messageInput.focus(); // Keep focus on the input field
                // Optional: Optimistically display the user's own message immediately
                // displayMessage({ ...currentUser, message: message, timestamp: new Date() });
            } else if (!socket.connected) {
                displaySystemMessage('錯誤：未連接到伺服器，無法發送訊息。');
            } else if (!currentUser) {
                 displaySystemMessage('錯誤：使用者資訊未載入，無法發送訊息。');
            }
        });
    } else {
        console.error('Chat form elements not found!');
    }

}); // End DOMContentLoaded