CREATE TABLE IF NOT EXISTS calls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    provider_call_id VARCHAR(128) NULL,
    telegram_chat_id VARCHAR(64) NULL,
    audio_url VARCHAR(512) NULL,
    last_digit VARCHAR(8) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    call_id INT NOT NULL,
    event VARCHAR(64) NOT NULL,
    digit VARCHAR(8) NULL,
    payload JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_call_logs_call_id (call_id),
    CONSTRAINT fk_call_logs_call
        FOREIGN KEY (call_id) REFERENCES calls(id)
        ON DELETE CASCADE
);
