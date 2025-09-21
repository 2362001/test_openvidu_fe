import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    createLocalScreenTracks,
    LocalTrack,
    LocalVideoTrack,
    RemoteParticipant,
    RemoteTrack,
    RemoteTrackPublication,
    Room,
    RoomEvent,
    Track,
    VideoPresets,
} from 'livekit-client';
import { lastValueFrom } from 'rxjs';
import { AudioComponent } from './audio/audio.component';
import { VideoComponent } from './video/video.component';
import { CommonModule } from '@angular/common';

type TrackInfo = {
    trackPublication: RemoteTrackPublication;
    participantIdentity: string;
};

let APPLICATION_SERVER_URL = '';
let LIVEKIT_URL = '';

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [ReactiveFormsModule, FormsModule, AudioComponent, VideoComponent, CommonModule],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss',
})
export class AppComponent implements OnDestroy {
    // ===== Form =====
    roomForm = new FormGroup({
        roomName: new FormControl('Test Room', Validators.required),
        participantName: new FormControl('Participant' + Math.floor(Math.random() * 100), Validators.required),
    });

    // ===== Signals (state) =====
    room = signal<Room | undefined>(undefined);

    // IMPORTANT: luôn tạo Map mới khi update để trigger re-render
    remoteTracksMap = signal<Map<string, TrackInfo>>(new Map());

    // hiển thị list tên nhanh (đơn giản) – có thể nâng cấp sang object identity/name nếu muốn
    participants = signal<string[]>([]);

    // chat
    messages = signal<{ from: string; text: string }[]>([]);
    chatInput = '';

    // local cam track để render chính mình
    localCamTrack = signal<LocalVideoTrack | undefined>(undefined);

    // screen-share flags
    isScreenSharing = false;
    private screenShareTracks: LocalTrack[] = [];

    // camera flags
    isCameraOn = false;
    camAndShare = false;
    currentFacing: 'user' | 'environment' = 'user';

    constructor(private httpClient: HttpClient) {
        this.configureUrls();
    }

    private configureUrls() {
        // DÙNG IP LAN/DOMAIN khi cần test đa thiết bị
        APPLICATION_SERVER_URL = 'http://192.168.137.1:6080/';
        LIVEKIT_URL = 'ws://192.168.137.1:7880';
    }

    // ====== Join Room ======
    async joinRoom() {
        const room = new Room();
        this.room.set(room);

        // DataChannel chat
        room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
            if (topic && topic !== 'chat') return;
            const text = new TextDecoder().decode(payload);
            const from = participant?.name || participant?.identity || 'Unknown';
            this.messages.update((list) => [...list, { from, text }]);
        });

        // Remote tracks
        room.on(
            RoomEvent.TrackSubscribed,
            (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
                // audio
                if (publication.kind === 'audio') {
                    this.remoteTracksMap.update((prev) => {
                        const next = new Map(prev);
                        next.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return next;
                    });
                }

                // video (Camera/ScreenShare/Unknown)
                const isRenderableVideo =
                    publication.kind === 'video' &&
                    [Track.Source.Camera, Track.Source.ScreenShare, Track.Source.Unknown].includes(
                        (publication.source as Track.Source) ?? Track.Source.Unknown
                    );

                if (isRenderableVideo) {
                    this.remoteTracksMap.update((prev) => {
                        const next = new Map(prev);
                        next.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return next;
                    });
                }
            }
        );

        room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
            this.remoteTracksMap.update((prev) => {
                const next = new Map(prev);
                next.delete(publication.trackSid);
                return next;
            });
        });

        // Participants in/out/name change + system message
        room.on(RoomEvent.ParticipantConnected, (p) => {
            const id = p.name || p.identity;
            this.participants.update((list) => Array.from(new Set([...list, id])));
            this.messages.update((list) => [...list, { from: 'Hệ thống', text: `${id} đã tham gia phòng` }]);
        });
        room.on(RoomEvent.ParticipantDisconnected, (p) => {
            const id = p.name || p.identity;
            this.participants.update((list) => list.filter((x) => x !== id));
            this.messages.update((list) => [...list, { from: 'Hệ thống', text: `${id} đã rời phòng` }]);
        });
        room.on(RoomEvent.ParticipantNameChanged, (name, p) => {
            const id = p.identity;
            this.participants.update((list) => {
                const next = list.slice();
                const prevId = next.findIndex((x) => x === (p.name || id) || x === id);
                if (prevId !== -1) next[prevId] = name || id;
                return next;
            });
        });

        // Local camera published/unpublished -> đồng bộ localCamTrack signal
        room.on(RoomEvent.LocalTrackPublished, (pub) => {
            if (pub.kind === 'video' && pub.source === Track.Source.Camera) {
                this.localCamTrack.set(pub.videoTrack as LocalVideoTrack);
                this.isCameraOn = true;
                this.recomputeCamShareFlags();
            }
        });
        room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
            if (pub.kind === 'video' && pub.source === Track.Source.Camera) {
                this.localCamTrack.set(undefined);
                this.isCameraOn = false;
                this.recomputeCamShareFlags();
            }
        });

        try {
            const roomName = this.roomForm.value.roomName!;
            const participantName = this.roomForm.value.participantName! + '-' + Math.floor(Math.random() * 10000);

            // 1) token
            const token = await this.getToken(roomName, participantName);

            // 2) connect
            await room.connect(LIVEKIT_URL, token);

            // 3) participants list (self + existing)
            const existing = Array.from(room.remoteParticipants.values()).map((p) => p.name || p.identity);
            this.participants.set([participantName, ...existing]);

            // 4) bật cam & mic theo mong muốn của bạn
            await room.localParticipant.setCameraEnabled(true, {
                facingMode: 'user' as any,
                resolution: VideoPresets.h540,
            });
            await room.localParticipant.setMicrophoneEnabled(true);

            // 5) set localCamTrack sau khi đã bật camera
            const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
            const vt = camPub?.videoTrack as LocalVideoTrack | undefined;
            this.localCamTrack.set(vt);
            this.isCameraOn = !!vt;
            this.recomputeCamShareFlags();
        } catch (error: any) {
            console.log('Error connecting:', error?.error?.errorMessage || error?.message || error);
            await this.leaveRoom();
        }
    }

    private recomputeCamShareFlags() {
        this.camAndShare = this.isCameraOn || this.isScreenSharing;
    }

    // ===== Chat =====
    async sendMessage() {
        if (!this.chatInput.trim() || !this.room()) return;
        const msg = this.chatInput.trim();
        const data = new TextEncoder().encode(msg);
        await this.room()!.localParticipant.publishData(data, { reliable: true, topic: 'chat' });
        this.messages.update((list) => [...list, { from: 'Me', text: msg }]);
        this.chatInput = '';
    }

    // ===== Leave / cleanup =====
    async leaveRoom() {
        if (this.isScreenSharing) await this.stopScreenShare();
        try {
            await this.room()?.disconnect();
        } catch {}
        this.room.set(undefined);
        this.remoteTracksMap.set(new Map());
        this.participants.set([]);
        this.localCamTrack.set(undefined);
        this.isCameraOn = false;
        this.isScreenSharing = false;
        this.camAndShare = false;
    }

    //đóng cửa sổ trình duyệt cần cancel hết
    @HostListener('window:pagehide')
    onPageHide() {
        try {
            this.room()?.disconnect();
        } catch {}
    }

    async ngOnDestroy() {
        await this.leaveRoom();
    }

    // ===== Backend token =====
    private async getToken(roomName: string, participantName: string): Promise<string> {
        const res = await lastValueFrom(
            this.httpClient.post<{ token: string }>(APPLICATION_SERVER_URL + 'token', { roomName, participantName })
        );
        return res.token;
    }

    // ===== Screen Share =====
    async toggleScreenShare() {
        if (!this.room()) return;
        try {
            if (!this.isScreenSharing) {
                const ok = await this.startScreenShare(true);
                if (!ok) console.warn('Screen share could not start');
            } else {
                await this.stopScreenShare();
            }
        } catch (e) {
            console.error('Screen share error', e);
        }
    }

    private async startScreenShare(audio = true) {
        const r = this.room();
        if (!r) return false;
        try {
            const tracks = await createLocalScreenTracks({ audio });
            this.screenShareTracks = tracks as LocalTrack[];

            for (const t of this.screenShareTracks) {
                await r.localParticipant.publishTrack(t);
                const mst = (t as LocalVideoTrack).mediaStreamTrack ?? (t as any).mediaStreamTrack;
                if (mst) {
                    mst.addEventListener(
                        'ended',
                        async () => {
                            await this.stopScreenShare();
                            this.recomputeCamShareFlags();
                        },
                        { once: true }
                    );
                }
            }
            this.isScreenSharing = true;
            this.recomputeCamShareFlags();
            return true;
        } catch (e) {
            console.error('startScreenShare failed', e);
            return false;
        }
    }

    private async stopScreenShare() {
        const r = this.room();
        if (!r) return;
        for (const t of this.screenShareTracks) {
            try {
                const media = (t as any).mediaStreamTrack as MediaStreamTrack | undefined;
                if (media) {
                    r.localParticipant.unpublishTrack(media, true);
                } else {
                    r.localParticipant.unpublishTrack(t, true);
                }
                t.stop();
            } catch {}
        }
        this.screenShareTracks = [];
        this.isScreenSharing = false;
    }

    // ===== Camera toggles =====
    async toggleCamAndShare() {
        const r = this.room();
        if (!r) return;
        try {
            if (!this.camAndShare) {
                // Bật camera (front -> fallback back)
                this.isCameraOn = false;
                try {
                    await r.localParticipant.setCameraEnabled(true, {
                        facingMode: 'user' as any,
                        resolution: VideoPresets.h540,
                    });
                    this.isCameraOn = true;
                } catch (e1) {
                    console.warn('Front cam failed, try back cam', e1);
                    try {
                        await r.localParticipant.setCameraEnabled(true, {
                            facingMode: 'environment' as any,
                            resolution: VideoPresets.h540,
                        });
                        this.isCameraOn = true;
                    } catch (e2) {
                        console.error('Camera failed, continue without video', e2);
                        this.isCameraOn = false;
                    }
                }

                // Bật screen share nếu chưa bật
                if (!this.isScreenSharing) {
                    const ok = await this.startScreenShare(true);
                    if (!ok) console.warn('Could not start screen share');
                }
                // sync localCamTrack
                const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
                this.localCamTrack.set(camPub?.videoTrack as LocalVideoTrack | undefined);

                this.recomputeCamShareFlags();
            } else {
                if (this.isCameraOn) {
                    try {
                        await r.localParticipant.setCameraEnabled(false);
                    } catch {}
                    this.isCameraOn = false;
                    this.localCamTrack.set(undefined);
                }
                if (this.isScreenSharing) await this.stopScreenShare();
                this.recomputeCamShareFlags();
            }
        } catch (e) {
            console.error('toggleCamAndShare error', e);
        }
    }

    async flipCamera() {
        const r = this.room();
        if (!r) return;

        const next = this.currentFacing === 'user' ? 'environment' : 'user';
        try {
            await r.localParticipant.setCameraEnabled(false);
            await r.localParticipant.setCameraEnabled(true, { facingMode: next, resolution: VideoPresets.h540 });
            this.currentFacing = next;

            const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
            const vt = camPub?.videoTrack as LocalVideoTrack | undefined;

            this.localCamTrack.set(vt);
            this.isCameraOn = !!vt;
            this.recomputeCamShareFlags();
        } catch (e) {
            console.error('flipCamera failed', e);
        }
    }

    // --- recording state ---
    private recorder?: MediaRecorder;
    private recordedBlobs: Blob[] = [];
    private recordingStream?: MediaStream;

    isRecording = false;

    // tiện ích lấy audio/mic local
    private getLocalMicMediaTrack(): MediaStreamTrack | undefined {
        const r = this.room();
        const micPub = r?.localParticipant.getTrackPublication(Track.Source.Microphone);
        return micPub?.audioTrack?.mediaStreamTrack;
    }

    // tiện ích lấy video local
    private getLocalCamMediaTrack(): MediaStreamTrack | undefined {
        const vt = this.localCamTrack();
        return vt?.mediaStreamTrack;
    }

    // tiện ích lấy MediaStreamTrack từ Remote publication (video/audio)
    private getRemoteMediaTracks(): MediaStreamTrack[] {
        const tracks: MediaStreamTrack[] = [];
        for (const info of this.remoteTracksMap().values()) {
            const pub = info.trackPublication;
            if (pub.kind === 'video' && pub.videoTrack?.mediaStreamTrack) {
                tracks.push(pub.videoTrack.mediaStreamTrack);
            }
            if (pub.kind === 'audio' && pub.audioTrack?.mediaStreamTrack) {
                tracks.push(pub.audioTrack.mediaStreamTrack);
            }
        }
        return tracks;
    }

    // bắt đầu ghi: bạn chọn preset (localOnly | localPlusRemote | onlyScreenShare ...)
    async startRecording(preset: 'localOnly' | 'localPlusRemote' | 'screenShare' = 'localOnly') {
        if (this.isRecording) return;
        const pieces: MediaStreamTrack[] = [];

        if (preset === 'localOnly' || preset === 'localPlusRemote') {
            const cam = this.getLocalCamMediaTrack();
            const mic = this.getLocalMicMediaTrack();
            if (cam) pieces.push(cam);
            if (mic) pieces.push(mic);
        }

        if (preset === 'localPlusRemote') {
            // thêm tất cả remote tracks hiện có (cẩn thận echo)
            // Nếu muốn chỉ lấy remote video (không audio) thì lọc ở đây
            const remotes = this.getRemoteMediaTracks();
            pieces.push(...remotes);
        }

        if (preset === 'screenShare') {
            // nếu bạn đang bật screen share local, lấy track của nó
            // tìm trong local publications nguồn ScreenShare/ScreenShareAudio
            const r = this.room();
            const ssVideo = r?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack
                ?.mediaStreamTrack;
            const ssAudio = r?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.audioTrack
                ?.mediaStreamTrack;
            if (ssVideo) pieces.push(ssVideo);
            if (ssAudio) pieces.push(ssAudio);
        }

        if (pieces.length === 0) {
            this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không có track nào để ghi.' }]);
            return;
        }

        this.recordingStream = new MediaStream(pieces);

        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
            ? 'video/webm;codecs=vp9,opus'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm';

        this.recordedBlobs = [];
        this.recorder = new MediaRecorder(this.recordingStream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });

        this.recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) this.recordedBlobs.push(e.data);
        };
        this.recorder.onstop = () => {
            const blob = new Blob(this.recordedBlobs, { type: this.recorder?.mimeType || 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            a.download = `record-${preset}-${ts}.webm`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        };

        this.recorder.start(500); // collect chunks
        this.isRecording = true;
        this.messages.update((l) => [...l, { from: 'Hệ thống', text: `Bắt đầu ghi (${preset})` }]);
    }

    stopRecording() {
        if (!this.isRecording || !this.recorder) return;
        this.recorder.stop();
        this.isRecording = false;

        try {
            // không stop các track gốc (vì chúng thuộc LiveKit); chỉ bỏ stream tạm
            this.recordingStream?.getTracks().forEach((t) => this.recordingStream?.removeTrack(t));
        } catch {}
        this.recordingStream = undefined;
        this.recorder = undefined;
        this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Đã dừng ghi và tải file.' }]);
    }
}
