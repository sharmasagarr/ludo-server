import { Request } from 'express';
import { Socket } from 'socket.io';

export interface User {
    id: string;
    username: string;
    name: string;
    password?: string;
    role: string;
    points: number;
    diamonds: number;
    current_dice_roll_balance: number;
    current_move_balance: number;
    kills: number;
    status: boolean;
    is_active: boolean;
    is_deleted: boolean;
    created_at: Date | string;
    updated_at: Date | string;
}

export interface Board {
    id: string;
    player1: string;
    player2: string | null;
    player3: string | null;
    player4: string | null;
    creator: string;
    creation_mode: 'manual' | 'system';
    start_time: Date | string | null;
    end_time: Date | string | null;
    status: 'active' | 'suspended' | 'finished';
    winner1: string | null;
    winner2: string | null;
    winner3: string | null;
    loser: string | null;
    is_active: boolean;
    is_deleted: boolean;
    created_at: Date | string;
    updated_at: Date | string;
}

export interface Pawn {
    id: string;
    board_id: string;
    player_id: string;
    type: 'main' | 'home' | 'base' | 'center';
    color: 'red' | 'blue' | 'green' | 'yellow';
    current_position: string | null;
    next_position: string | null;
    is_safe: boolean;
    has_heart: boolean;
    moves: number;
    moves_lost: number;
    kills: number;
    prev_position: string | null;
    last_moved_at: Date | string | null;
    is_active: boolean;
    is_deleted: boolean;
    created_at: Date | string;
    updated_at: Date | string;
}

export interface DiceRoll {
    player_id: string;
    current_board_id: string | null;
    dice_value: number | null;
    rolled_at: Date | string;
    is_active: boolean;
    is_deleted: boolean;
    created_at: Date | string;
    updated_at: Date | string;
}

export interface AuthenticatedUser {
    id: string;
    username: string;
    role: string;
    iat?: number;
    exp?: number;
}

export interface AuthRequest extends Request {
    user?: AuthenticatedUser;
}

export interface GameSocket extends Socket {
    user?: AuthenticatedUser;
    board_id?: string;
    player_id?: string;
    joinedAt?: string;
}
