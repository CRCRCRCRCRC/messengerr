document.addEventListener('DOMContentLoaded', () => {
    const nicknameForm = document.getElementById('nickname-form');
    const errorMessage = document.getElementById('error-message');
    const nicknameInput = document.getElementById('nickname');
    const submitButton = document.getElementById('submit-button');
    const validationMessage = document.getElementById('nickname-validation');

    // Function to validate nickname
    function validateNickname() {
        const nickname = nicknameInput.value.trim();
        if (nickname.length === 0) {
            validationMessage.textContent = ''; // No message if empty yet
            validationMessage.style.display = 'none';
            return false; // Invalid if required and empty after submit attempt
        } else if (nickname.length < 2 || nickname.length > 20) {
            validationMessage.textContent = '長度必須介於 2 到 20 個字元之間。';
            validationMessage.style.display = 'block';
            return false; // Invalid length
        } else {
            validationMessage.textContent = '';
            validationMessage.style.display = 'none';
            return true; // Valid
        }
    }

    // Real-time validation feedback on input
    if(nicknameInput && validationMessage) {
        nicknameInput.addEventListener('input', validateNickname);
    }


    if (nicknameForm && nicknameInput && submitButton && errorMessage && validationMessage) {
        nicknameForm.addEventListener('submit', async (event) => {
            event.preventDefault(); // Prevent default form submission
            errorMessage.textContent = ''; // Clear previous general errors

            // Perform final validation on submit
            if (!validateNickname()) {
                 nicknameInput.focus();
                 return; // Stop submission if invalid
            }

            // Disable form elements during submission
            nicknameInput.disabled = true;
            submitButton.disabled = true;
            submitButton.textContent = '設定中...'; // Indicate loading

            const nickname = nicknameInput.value.trim();

            try {
                // Send request to the backend API
                const response = await fetch('/api/user/set-nickname', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        // Add CSRF token header here if implemented
                    },
                    body: JSON.stringify({ nickname: nickname }),
                });

                // Parse the JSON response from the backend
                const result = await response.json();

                if (response.ok) {
                    // Nickname set successfully, redirect as instructed by backend
                    window.location.href = result.redirectTo || '/chat'; // Redirect to chat page
                } else {
                    // Display error message from the backend
                    errorMessage.textContent = result.message || `發生錯誤 (${response.status})`;
                    // Re-enable form on error
                    nicknameInput.disabled = false;
                    submitButton.disabled = false;
                    submitButton.textContent = '確認並進入聊天室';
                    nicknameInput.focus();
                }
            } catch (error) {
                // Handle network errors or other exceptions
                console.error('Error submitting nickname:', error);
                errorMessage.textContent = '無法連接到伺服器，請檢查您的網路連線。';
                // Re-enable form on error
                nicknameInput.disabled = false;
                submitButton.disabled = false;
                submitButton.textContent = '確認並進入聊天室';
            }
        });
    }
});