DROP DATABASE IF EXISTS ludo_db;
CREATE DATABASE ludo_db;
USE ludo_db;

-- 1. Create Users Table
CREATE TABLE users (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    username VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user',
    points INT DEFAULT 0,
    diamonds INT DEFAULT 0,
    current_dice_roll_balance INT DEFAULT 20,
    current_move_balance INT DEFAULT 0,
    kills INT DEFAULT 0,
    status BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO users (username, name, password)
VALUES ('testuser', 'Test Player', '1234');

-- 2. Create Boards Table
CREATE TABLE boards (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    player1 VARCHAR(36) NOT NULL,
    player2 VARCHAR(36),
    player3 VARCHAR(36),
    player4 VARCHAR(36),
    creator VARCHAR(36) NOT NULL,
    creation_mode ENUM('manual','system'),
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME DEFAULT NULL,
    status ENUM('active','suspended','finished'),
    winner1 VARCHAR(36),
    winner2 VARCHAR(36),
    winner3 VARCHAR(36),
    loser VARCHAR(36),
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_boards_player1 (player1),
    INDEX idx_boards_player2 (player2),
    INDEX idx_boards_player3 (player3),
    INDEX idx_boards_player4 (player4),
    INDEX idx_boards_creator (creator),
    INDEX idx_boards_winner1 (winner1),
    INDEX idx_boards_winner2 (winner2),
    INDEX idx_boards_winner3 (winner3),
    INDEX idx_boards_loser (loser),
    CONSTRAINT fk_boards_player1 FOREIGN KEY (player1) REFERENCES users(id),
    CONSTRAINT fk_boards_player2 FOREIGN KEY (player2) REFERENCES users(id),
    CONSTRAINT fk_boards_player3 FOREIGN KEY (player3) REFERENCES users(id),
    CONSTRAINT fk_boards_player4 FOREIGN KEY (player4) REFERENCES users(id),
    CONSTRAINT fk_boards_creator FOREIGN KEY (creator) REFERENCES users(id),
    CONSTRAINT fk_boards_winner1 FOREIGN KEY (winner1) REFERENCES users(id),
    CONSTRAINT fk_boards_winner2 FOREIGN KEY (winner2) REFERENCES users(id),
    CONSTRAINT fk_boards_winner3 FOREIGN KEY (winner3) REFERENCES users(id),
    CONSTRAINT fk_boards_loser FOREIGN KEY (loser) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. Create Pawns Table
CREATE TABLE pawns (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    board_id VARCHAR(36) NOT NULL,
    player_id VARCHAR(36) NOT NULL,
    type ENUM('main','home','base') NOT NULL,
    color ENUM('red','blue','green','yellow'),
    current_position VARCHAR(36),
    next_position VARCHAR(36),
    is_safe BOOLEAN DEFAULT FALSE,
    has_heart BOOLEAN DEFAULT FALSE,
    moves INT DEFAULT 0,
    moves_lost INT DEFAULT 0,
    kills INT DEFAULT 0,
    prev_position VARCHAR(36),
    last_moved_at TIMESTAMP NULL DEFAULT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_pawns_board_id (board_id),
    INDEX idx_pawns_player_id (player_id),
    CONSTRAINT fk_pawns_board FOREIGN KEY (board_id) REFERENCES boards(id),
    CONSTRAINT fk_pawns_player FOREIGN KEY (player_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 4. Create Dice Rolls Table
CREATE TABLE dice_rolls (
    player_id VARCHAR(36) NOT NULL,
    current_board_id VARCHAR(36),
    dice_value INT,
    rolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id),
    CONSTRAINT fk_dice_rolls_player FOREIGN KEY (player_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 5. Create Dice Roll Logs Table
CREATE TABLE dice_roll_logs (
    id INT NOT NULL AUTO_INCREMENT,
    board_id VARCHAR(36) NOT NULL,
    player_id VARCHAR(36) NOT NULL,
    dice_value INT,
    valid_moves JSON,
    rolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_dice_logs_board_id (board_id),
    INDEX idx_dice_logs_player_id (player_id),
    CONSTRAINT fk_dice_logs_board FOREIGN KEY (board_id) REFERENCES boards(id),
    CONSTRAINT fk_dice_logs_player FOREIGN KEY (player_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 6. Create Move Logs Table
CREATE TABLE move_logs (
    id INT NOT NULL AUTO_INCREMENT,
    board_id VARCHAR(36) NOT NULL,
    player_id VARCHAR(36) NOT NULL,
    pawn_id VARCHAR(36),
    dice_value INT,
    from_position VARCHAR(36),
    to_position VARCHAR(36),
    has_captured BOOLEAN DEFAULT FALSE,
    got_captured BOOLEAN DEFAULT FALSE,
    captured_pawn_ids JSON,
    actual_moves INT DEFAULT 0,
    prev_move_balance INT DEFAULT 0,
    at_dice_roll_balance INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    is_deleted BOOLEAN DEFAULT FALSE,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_move_logs_board_id (board_id),
    INDEX idx_move_logs_player_id (player_id),
    CONSTRAINT fk_move_logs_board FOREIGN KEY (board_id) REFERENCES boards(id),
    CONSTRAINT fk_move_logs_player FOREIGN KEY (player_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
