'use client';

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>;
  }
}

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BoardSide, DebugEvent, DeviceState, LogEntry } from './types';
import { DEFAULT_DEVICE_STATE } from './types';
import * as DeviceService from './device-service';

const MAX_LOG_ENTRIES = 800;

/** 双板状态：A / B 各自一份完整 DeviceState */
export type BoardStates = Record<BoardSide, DeviceState>;

function makeDefaultBoard(board: BoardSide): DeviceState {
  return {
    ...DEFAULT_DEVICE_STATE,
    board,
    telemetry: { ...DEFAULT_DEVICE_STATE.telemetry },
    params: {},
  };
}

function pickNum(a: number | null | undefined, b: number | null | undefined): number | null {
  return a ?? b ?? null;
}

/** 将两块板的遥测/状态合并成现有页面使用的单一视图 */
export function mergeBoards(a: DeviceState, b: DeviceState): DeviceState {
  const ta = a.telemetry;
  const tb = b.telemetry;
  const state =
    ta.state === 'FAULT' || tb.state === 'FAULT'
      ? 'FAULT'
      : ta.state === 'STEER_RUN' || tb.state === 'STEER_RUN'
        ? 'STEER_RUN'
        : ta.state === 'PEDAL_RUN' || tb.state === 'PEDAL_RUN'
          ? 'PEDAL_RUN'
          : 'IDLE';
  const pedalSelect =
    ta.pedal_select !== 'NONE' ? ta.pedal_select : tb.pedal_select !== 'NONE' ? tb.pedal_select : 'NONE';
  const ids = [
    a.device_id ? `A:${a.device_id}` : '',
    b.device_id ? `B:${b.device_id}` : '',
  ].filter(Boolean);

  return {
    board: 'A+B',
    is_connected: a.is_connected || b.is_connected,
    plain_mode: a.plain_mode || b.plain_mode,
    device_id: ids.join(' '),
    fw_version: a.fw_version || b.fw_version,
    info: a.info ?? b.info,
    telemetry: {
      t: Math.max(ta.t ?? 0, tb.t ?? 0),
      side: ta.side || tb.side,
      tilt_x: pickNum(ta.tilt_x, tb.tilt_x),
      tilt_y: pickNum(ta.tilt_y, tb.tilt_y),
      pedal_a_tilt_x: pickNum(ta.pedal_a_tilt_x, tb.pedal_a_tilt_x),
      pedal_a_tilt_y: pickNum(ta.pedal_a_tilt_y, tb.pedal_a_tilt_y),
      pedal_b_tilt_x: pickNum(ta.pedal_b_tilt_x, tb.pedal_b_tilt_x),
      pedal_b_tilt_y: pickNum(ta.pedal_b_tilt_y, tb.pedal_b_tilt_y),
      laser_a: pickNum(ta.laser_a, tb.laser_a),
      laser_b: pickNum(ta.laser_b, tb.laser_b),
      pedal_a: pickNum(ta.pedal_a, tb.pedal_a),
      pedal_b: pickNum(ta.pedal_b, tb.pedal_b),
      push_a_raw: pickNum(ta.push_a_raw, tb.push_a_raw),
      push_b_raw: pickNum(ta.push_b_raw, tb.push_b_raw),
      push_a_st: pickNum(ta.push_a_st, tb.push_a_st),
      push_b_st: pickNum(ta.push_b_st, tb.push_b_st),
      ang_cor_a: pickNum(ta.ang_cor_a, tb.ang_cor_a),
      ang_cor_b: pickNum(ta.ang_cor_b, tb.ang_cor_b),
      steer_x: pickNum(ta.steer_x, tb.steer_x),
      steer_y: pickNum(ta.steer_y, tb.steer_y),
      steer_free: pickNum(ta.steer_free, tb.steer_free),
      sensor: ta.sensor === 'NG' || tb.sensor === 'NG' ? 'NG' : 'OK',
      state,
      pedal_select: pedalSelect,
    },
    params: { ...(b.params ?? {}), ...(a.params ?? {}) },
    last_error: a.last_error ?? b.last_error,
  };
}

/**
 * 设备订阅 Hook（A/B 双板）：
 * - boards: A / B 两块板各自状态（连接、遥测、错误）
 * - state: 合并视图，兼容现有页面（A 板报 A 侧字段、B 板报 B 侧字段）
 * - debugLog: 通信日志（带 board）
 * - lastEvent: DEBUG 流程事件（带 board）
 * - actions: 全部命令（按板路由，统一错误处理）
 */
export function useDevice() {
  const [boards, setBoards] = useState<BoardStates>(() => ({
    A: makeDefaultBoard('A'),
    B: makeDefaultBoard('B'),
  }));
  const [debugLog, setDebugLog] = useState<LogEntry[]>([]);
  const [lastEvent, setLastEvent] = useState<DebugEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        const unlistenState = await listen<DeviceState>('device-state-changed', (event) => {
          if (!mounted) return;
          const payload = event.payload;
          const board = (payload.board === 'B' ? 'B' : 'A') as BoardSide;
          setBoards((prev) => ({ ...prev, [board]: { ...payload, board } }));
        });

        const unlistenLog = await listen<LogEntry>('device-debug-log', (event) => {
          if (mounted) {
            setDebugLog((prev) => {
              const next = [...prev, event.payload];
              return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
            });
          }
        });

        const unlistenEvent = await listen<DebugEvent>('pedal-event', (event) => {
          if (mounted) setLastEvent(event.payload);
        });

        unlistenRefs.current = [unlistenState, unlistenLog, unlistenEvent];

        // 初始化两块板状态
        const initial = await DeviceService.getBoardStates().catch(() => null);
        if (mounted) {
          if (initial) {
            setBoards({
              A: { ...makeDefaultBoard('A'), ...initial.a, board: 'A' },
              B: { ...makeDefaultBoard('B'), ...initial.b, board: 'B' },
            });
          } else {
            const [a, b] = await Promise.all([
              DeviceService.getState('A').catch(() => makeDefaultBoard('A')),
              DeviceService.getState('B').catch(() => makeDefaultBoard('B')),
            ]);
            if (mounted) setBoards({ A: { ...a, board: 'A' }, B: { ...b, board: 'B' } });
          }
        }
      } catch (e) {
        if (typeof window !== 'undefined' && !window.__TAURI__) {
          console.warn('[useDevice] Not in Tauri environment');
        } else {
          console.error('[useDevice] Setup error:', e);
        }
      }
    };

    setup();

    return () => {
      mounted = false;
      unlistenRefs.current.forEach((fn) => fn());
    };
  }, []);

  // 统一错误处理包装
  const withErrorHandling = useCallback(<T extends (...args: any[]) => Promise<void>>(fn: T) => {
    return (async (...args: Parameters<T>) => {
      try {
        setError(null);
        await fn(...args);
      } catch (e: any) {
        let msg = '操作失败';
        if (typeof e === 'string') {
          msg = e;
        } else if (e?.message) {
          msg = e.message;
        } else if (e?.toString && e.toString() !== '[object Event]') {
          msg = e.toString();
        }
        setError(msg);
        throw new Error(msg);
      }
    }) as T;
  }, []);

  // actions 引用稳定化：避免 20Hz 状态更新导致下游 memo 组件全部失效
  const actions = useMemo(() => {
    const wrap = (fn: (...args: any[]) => Promise<void>) => withErrorHandling(fn);
    return {
      // 连接
      connect: wrap(DeviceService.connect),
      disconnect: wrap(DeviceService.disconnect),
      estop: DeviceService.estop,
      infoGet: DeviceService.infoGet,
      sendRaw: wrap(DeviceService.sendRaw),
      debugSet: wrap(DeviceService.debugSet),
      plainModeSet: wrap(DeviceService.plainModeSet),
      // SET
      setReport: wrap(DeviceService.setReport),
      setLevelMethod: wrap(DeviceService.setLevelMethod),
      setPushPulsesPerMm: wrap(DeviceService.setPushPulsesPerMm),
      setPushFeed: wrap(DeviceService.setPushFeed),
      setLevelSpeed: wrap(DeviceService.setLevelSpeed),
      setLevelTol: wrap(DeviceService.setLevelTol),
      setLevelRatio: wrap(DeviceService.setLevelRatio),
      setMshZeroClear: wrap(DeviceService.setMshZeroClear),
      setBoardSide: wrap(DeviceService.setBoardSide),
      getParams: DeviceService.getParams,
      scanModbus: wrap(DeviceService.scanModbus),
      resetFault: wrap(DeviceService.resetFault),
      // NET
      netGetcfg: DeviceService.netGetcfg,
      netSetcfg: wrap(DeviceService.netSetcfg),
      netReset: wrap(DeviceService.netReset),
      // PEDAL
      pedalSelect: wrap(DeviceService.pedalSelect),
      pedalStart: wrap(DeviceService.pedalStart),
      pedalStop: wrap(DeviceService.pedalStop),
      pedalSetload: wrap(DeviceService.pedalSetload),
      pedalLevel: wrap(DeviceService.pedalLevel),
      pedalPushStart: wrap(DeviceService.pedalPushStart),
      pedalPushStop: wrap(DeviceService.pedalPushStop),
      pedalSet: wrap(DeviceService.pedalSet),
      pedalZero: wrap(DeviceService.pedalZero),
      pedalClear: wrap(DeviceService.pedalClear),
      pedalRecord: wrap(DeviceService.pedalRecord),
      // MOTOR
      motorEnable: wrap(DeviceService.motorEnable),
      motorDisable: wrap(DeviceService.motorDisable),
      motorStopAll: wrap(DeviceService.motorStopAll),
      motorMove: wrap(DeviceService.motorMove),
      motorMoveabs: wrap(DeviceService.motorMoveabs),
      motorHome: wrap(DeviceService.motorHome),
      motorStop: wrap(DeviceService.motorStop),
      motorZero: wrap(DeviceService.motorZero),
      // STEER
      steerStart: wrap(DeviceService.steerStart),
      steerStop: wrap(DeviceService.steerStop),
      getDebugLog: DeviceService.getDebugLog,
      clearDebugLog: () => setDebugLog([]),
      clearError: () => setError(null),
      clearLastEvent: () => setLastEvent(null),
    };
    // withErrorHandling 依赖为 []，此处仅需初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = useMemo(() => mergeBoards(boards.A, boards.B), [boards]);

  return { state, boards, actions, debugLog, lastEvent, error };
}
