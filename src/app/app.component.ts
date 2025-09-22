import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    createLocalScreenTracks,
    LocalAudioTrack,
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

    // danh sách file đã nhận để hiển thị link tải
    receivedFiles = signal<{ id: string; from: string; name: string; size: number; type: string; url: string }[]>([]);

    // track tiến độ gửi/nhận (tuỳ chọn, để show progress)
    transfers = new Map<
        string,
        {
            name: string;
            size: number;
            type: string;
            total: number;
            received: number;
            chunks: BlobPart[];
            from: string;
        }
    >();

    // chunk size phù hợp cho DataChannel
    private readonly FILE_CHUNK = 16 * 1024; // 16KB

    constructor(private httpClient: HttpClient) {
        this.configureUrls();
    }
    private configureUrls() {
        // DÙNG IP LAN/DOMAIN khi cần test đa thiết bị
        APPLICATION_SERVER_URL = 'http://127.0.0.1:6080/';
        LIVEKIT_URL = 'ws://127.0.0.1:7880';
    }

    //region Join Room ======
    async joinRoom() {
        const room = new Room();
        this.room.set(room);

        // ===== DataChannel chat
        // 1) meta
        room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
            // chat như cũ
            if (!topic || topic === 'chat') {
                const text = new TextDecoder().decode(payload);
                const from = participant?.name || participant?.identity || 'Unknown';
                this.messages.update((list) => [...list, { from, text }]);
                return;
            }

            // file meta
            if (topic === 'file-meta') {
                try {
                    const meta = JSON.parse(new TextDecoder().decode(payload)) as {
                        id: string;
                        name: string;
                        size: number;
                        type: string;
                        total: number;
                    };
                    this.transfers.set(meta.id, {
                        name: meta.name,
                        size: meta.size,
                        type: meta.type,
                        total: meta.total,
                        received: 0,
                        chunks: [],
                        from: participant?.name || participant?.identity || 'Unknown',
                    });
                } catch {}
                return;
            }

            // file chunk
            if (topic?.startsWith('file-chunk:')) {
                const id = topic.split(':')[1];
                const t = this.transfers.get(id);
                if (!t) return; // chưa có meta

                // payload là ArrayBuffer -> Uint8Array
                const u8 = new Uint8Array(payload);
                t.chunks.push(u8);
                t.received++;

                // đủ chunk -> ghép file
                if (t.received >= t.total) {
                    const blob = new Blob(t.chunks, { type: t.type || 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    this.receivedFiles.update((list) => [
                        ...list,
                        {
                            id,
                            from: t.from,
                            name: t.name,
                            size: t.size,
                            type: t.type,
                            url,
                        },
                    ]);
                    this.messages.update((list) => [
                        ...list,
                        { from: 'Hệ thống', text: `Đã nhận tệp: ${t.name} (${Math.round(t.size / 1024)} KB)` },
                    ]);
                    this.transfers.delete(id);
                }
                return;
            }
        });

        // ===== Remote tracks
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

        // ===== Participants in/out/name change + system message
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

        // ===== Local tracks: Camera + Microphone publish/unpublish
        room.on(RoomEvent.LocalTrackPublished, (pub) => {
            if (pub.kind === 'video' && pub.source === Track.Source.Camera) {
                this.localCamTrack.set(pub.videoTrack as LocalVideoTrack);
                this.isCameraOn = true;
                this.recomputeCamShareFlags();
            }
            if (pub.kind === 'audio' && pub.source === Track.Source.Microphone) {
                this.isMicOn = true;
            }
        });

        room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
            if (pub.kind === 'video' && pub.source === Track.Source.Camera) {
                this.localCamTrack.set(undefined);
                this.isCameraOn = false;
                this.recomputeCamShareFlags();
            }
            if (pub.kind === 'audio' && pub.source === Track.Source.Microphone) {
                this.isMicOn = false;
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

            // 4) BẬT MIC TRƯỚC (có kiểm tra thiết bị & fallback)
            await this.tryEnableMic(room);

            // 5) BẬT CAM (có kiểm tra thiết bị & fallback)
            await this.tryEnableCamera(room);
        } catch (error: any) {
            console.log('Error connecting:', error?.error?.errorMessage || error?.message || error);
            await this.leaveRoom();
        }
    }

    async sendFile(file: File) {
        const r = this.room();
        if (!r) return;

        // đọc toàn bộ file thành ArrayBuffer
        const buf = await file.arrayBuffer();
        const totalChunks = Math.ceil(buf.byteLength / this.FILE_CHUNK);
        const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        // 1) gửi meta trước (JSON string, reliable)
        const meta = { id, name: file.name, size: file.size, type: file.type, total: totalChunks };
        await r.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(meta)), {
            reliable: true,
            topic: 'file-meta',
        });

        // 2) gửi từng chunk nhị phân
        for (let i = 0; i < totalChunks; i++) {
            const start = i * this.FILE_CHUNK;
            const end = Math.min(start + this.FILE_CHUNK, buf.byteLength);

            // ArrayBuffer -> Uint8Array
            const chunk = new Uint8Array(buf.slice(start, end));

            await r.localParticipant.publishData(chunk, {
                reliable: true,
                topic: `file-chunk:${id}`,
            });
        }

        // thông báo local
        this.messages.update((l) => [
            ...l,
            { from: 'Hệ thống', text: `Đã gửi tệp: ${file.name} (${Math.round(file.size / 1024)} KB)` },
        ]);
    }

    pendingFile?: File;

    onFilePicked(ev: Event) {
        const input = ev.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        this.pendingFile = file;
        // gửi ngay lập tức (hoặc bạn có thể thêm nút "Send file")
        this.sendFile(file).finally(() => {
            (ev.target as HTMLInputElement).value = ''; // reset input
            this.pendingFile = undefined;
        });
    }

    isMicOn = false;

    private async tryEnableCamera(room: Room): Promise<boolean> {
        // 1) liệt kê device
        let devices: MediaDeviceInfo[] = [];
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            // một số trình duyệt cần gọi getUserMedia trước khi enumerateDevices có tên
        }
        const hasVideoInput = devices.some((d) => d.kind === 'videoinput');

        // 2) Nếu không có webcam → bỏ qua, không bật camera
        if (!hasVideoInput) {
            this.messages.update((l) => [
                ...l,
                { from: 'Hệ thống', text: 'Không phát hiện webcam - vào phòng ở chế độ không video.' },
            ]);
            return false;
        }

        // 3) Thử bật với ràng buộc “nhẹ” (không đặt facingMode trên desktop)
        const constraints = {
            facingMode: undefined as any, // bỏ facingMode để tránh Overconstrained trên máy bàn
            resolution: VideoPresets.h540, // có thể giảm xuống h360 nếu cần
        };

        try {
            await room.localParticipant.setCameraEnabled(true, constraints);
            const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
            const vt = camPub?.videoTrack as LocalVideoTrack | undefined;
            this.localCamTrack.set(vt);
            this.isCameraOn = !!vt;
            this.recomputeCamShareFlags();
            return this.isCameraOn;
        } catch (e: any) {
            const msg = e?.error?.errorMessage || e?.message || String(e);
            this.messages.update((l) => [
                ...l,
                { from: 'Hệ thống', text: `Không bật được camera: ${msg}. Sẽ tiếp tục không video.` },
            ]);
            // đảm bảo tắt cờ
            this.localCamTrack.set(undefined);
            this.isCameraOn = false;
            this.recomputeCamShareFlags();
            return false;
        }
    }

    private async tryEnableMic(room: Room): Promise<boolean> {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const hasMic = devices.some((d) => d.kind === 'audioinput');
            if (!hasMic) {
                this.messages.update((l) => [
                    ...l,
                    { from: 'Hệ thống', text: 'Không phát hiện micro - vào phòng ở chế độ mute.' },
                ]);
                this.isMicOn = false;
                return false;
            }
        } catch {}

        try {
            await room.localParticipant.setMicrophoneEnabled(true);
            this.isMicOn = true;
            return true;
        } catch (e: any) {
            const msg = e?.error?.errorMessage || e?.message || String(e);
            this.messages.update((l) => [...l, { from: 'Hệ thống', text: `Không bật được micro: ${msg}` }]);
            this.isMicOn = false;
            return false;
        }
    }

    async toggleMic() {
        const r = this.room();
        if (!r) return;

        try {
            // Cách 1 (khuyến nghị): mute/unmute mà vẫn giữ publication
            const micPub = r.localParticipant.getTrackPublication(Track.Source.Microphone);
            const at = micPub?.audioTrack as LocalAudioTrack | undefined;

            if (at) {
                if (this.isMicOn) await at.mute();
                else await at.unmute();
                this.isMicOn = !this.isMicOn;
            } else {
                // Fallback: nếu chưa có track, bật/tắt bằng setMicrophoneEnabled
                await r.localParticipant.setMicrophoneEnabled(!this.isMicOn);
                this.isMicOn = !this.isMicOn;
            }
        } catch (e) {
            console.error('toggleMic error', e);
            this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không thể đổi trạng thái micro.' }]);
        }
    }

    @HostListener('window:keydown', ['$event'])
    onKeydown(e: KeyboardEvent) {
        if ((e.key === 'm' || e.key === 'M') && this.room()) {
            e.preventDefault();
            this.toggleMic();
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
    // async startRecording(preset: 'localOnly' | 'localPlusRemote' | 'screenShare' = 'localOnly') {
    //     if (this.isRecording) return;
    //     const pieces: MediaStreamTrack[] = [];

    //     if (preset === 'localOnly' || preset === 'localPlusRemote') {
    //         const cam = this.getLocalCamMediaTrack();
    //         const mic = this.getLocalMicMediaTrack();
    //         if (cam) pieces.push(cam);
    //         if (mic) pieces.push(mic);
    //     }

    //     if (preset === 'localPlusRemote') {
    //         // thêm tất cả remote tracks hiện có (cẩn thận echo)
    //         // Nếu muốn chỉ lấy remote video (không audio) thì lọc ở đây
    //         const remotes = this.getRemoteMediaTracks();
    //         pieces.push(...remotes);
    //     }

    //     if (preset === 'screenShare') {
    //         // 1) nếu chưa share thì bật share ngay
    //         if (!this.isScreenSharing) {
    //             const ok = await this.startScreenShare(true); // audio hệ thống nếu browser cho (HTTPS/localhost)
    //             if (!ok) {
    //                 this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không bật được Screen Share.' }]);
    //                 return;
    //             }
    //         }

    //         // 2) lấy trực tiếp từ this.screenShareTracks (đã được createLocalScreenTracks)
    //         for (const t of this.screenShareTracks) {
    //             const mst: MediaStreamTrack | undefined =
    //                 (t as any).mediaStreamTrack ?? (t as LocalVideoTrack).mediaStreamTrack;
    //             if (mst) pieces.push(mst);
    //         }

    //         // 3) fallback cuối: tự xin getDisplayMedia để ghi riêng (không publish vào room)
    //         if (pieces.length === 0) {
    //             try {
    //                 const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    //                 stream.getTracks().forEach((tr) => pieces.push(tr));
    //             } catch (e) {
    //                 this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không thể lấy màn hình để ghi.' }]);
    //                 return;
    //             }
    //         }
    //     }

    //     if (pieces.length === 0) {
    //         this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không có track nào để ghi.' }]);
    //         return;
    //     }

    //     this.recordingStream = new MediaStream(pieces);

    //     const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    //         ? 'video/webm;codecs=vp9,opus'
    //         : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    //         ? 'video/webm;codecs=vp8,opus'
    //         : 'video/webm';

    //     this.recordedBlobs = [];
    //     this.recorder = new MediaRecorder(this.recordingStream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });

    //     this.recorder.ondataavailable = (e) => {
    //         if (e.data && e.data.size > 0) this.recordedBlobs.push(e.data);
    //     };
    //     this.recorder.onstop = () => {
    //         const blob = new Blob(this.recordedBlobs, { type: this.recorder?.mimeType || 'video/webm' });
    //         const url = URL.createObjectURL(blob);
    //         const a = document.createElement('a');
    //         a.href = url;
    //         const ts = new Date().toISOString().replace(/[:.]/g, '-');
    //         a.download = `record-${preset}-${ts}.webm`;
    //         a.click();
    //         setTimeout(() => URL.revokeObjectURL(url), 10_000);
    //     };

    //     this.recorder.start(500); // collect chunks
    //     this.isRecording = true;
    //     this.messages.update((l) => [...l, { from: 'Hệ thống', text: `Bắt đầu ghi (${preset})` }]);
    // }

    async startRecording(preset: 'localOnly' | 'localPlusRemote' | 'screenShare' = 'localOnly') {
        if (this.isRecording) return;

        const videoTracks: MediaStreamTrack[] = [];
        const audioTracksToMix: MediaStreamTrack[] = [];

        // --- A) SCREEN SHARE ---
        if (preset === 'screenShare') {
            // Bật share nếu chưa bật
            if (!this.isScreenSharing) {
                const ok = await this.startScreenShare(true /* yêu cầu audio nếu có thể */);
                if (!ok) {
                    this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không bật được Screen Share.' }]);
                    return;
                }
            }

            // Lấy trực tiếp từ screenShareTracks do createLocalScreenTracks trả về
            for (const t of this.screenShareTracks) {
                const mst = (t as any).mediaStreamTrack;
                if (!mst) continue;
                if (mst.kind === 'video') videoTracks.push(mst);
                if (mst.kind === 'audio') audioTracksToMix.push(mst);
            }

            // Fallback: nếu vì lý do nào đó không lấy được (hiếm), xin getDisplayMedia để ghi riêng tư
            if (videoTracks.length === 0) {
                try {
                    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                    stream.getVideoTracks().forEach((v) => videoTracks.push(v));
                    stream.getAudioTracks().forEach((a) => audioTracksToMix.push(a));
                } catch {
                    this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không thể lấy màn hình để ghi.' }]);
                    return;
                }
            }

            // (Tuỳ chọn) trộn thêm MIC local hoặc remote audio cho file ghi
            const wantMic = true; // đổi theo ý bạn
            const wantRemote = false; // true nếu muốn trộn tiếng người khác vào file

            if (wantMic) {
                const micPub = this.room()?.localParticipant.getTrackPublication(Track.Source.Microphone);
                const mic = micPub?.audioTrack?.mediaStreamTrack;
                if (mic) audioTracksToMix.push(mic);
            }
            if (wantRemote) {
                for (const info of this.remoteTracksMap().values()) {
                    const at = info.trackPublication.audioTrack?.mediaStreamTrack;
                    if (at) audioTracksToMix.push(at);
                }
            }
        }

        // --- B) LOCAL ONLY ---
        if (preset === 'localOnly') {
            const cam = this.localCamTrack()?.mediaStreamTrack;
            if (cam) videoTracks.push(cam);
            const micPub = this.room()?.localParticipant.getTrackPublication(Track.Source.Microphone);
            const mic = micPub?.audioTrack?.mediaStreamTrack;
            if (mic) audioTracksToMix.push(mic);
        }

        // --- C) LOCAL + REMOTE ---
        if (preset === 'localPlusRemote') {
            const cam = this.localCamTrack()?.mediaStreamTrack;
            if (cam) videoTracks.push(cam);
            const micPub = this.room()?.localParticipant.getTrackPublication(Track.Source.Microphone);
            const mic = micPub?.audioTrack?.mediaStreamTrack;
            if (mic) audioTracksToMix.push(mic);

            // remote video (tuỳ chọn)
            for (const info of this.remoteTracksMap().values()) {
                const vt = info.trackPublication.videoTrack?.mediaStreamTrack;
                if (vt) videoTracks.push(vt);
                const at = info.trackPublication.audioTrack?.mediaStreamTrack;
                if (at) audioTracksToMix.push(at);
            }
        }

        if (videoTracks.length === 0 && audioTracksToMix.length === 0) {
            this.messages.update((l) => [...l, { from: 'Hệ thống', text: 'Không có track nào để ghi.' }]);
            return;
        }

        // --- D) MIX tất cả audio -> 1 track duy nhất ---
        let mixedAudioTrack: MediaStreamTrack | undefined;
        if (audioTracksToMix.length > 0) {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const dest = ctx.createMediaStreamDestination();

            // Kết mỗi audio track vào destination
            for (const at of audioTracksToMix) {
                try {
                    const src = ctx.createMediaStreamSource(new MediaStream([at]));
                    // (tuỳ chọn) có thể thêm GainNode để chỉnh âm lượng từng nguồn
                    src.connect(dest);
                } catch {
                    // bỏ qua nếu browser không cho kết nối một số track đặc thù
                }
            }

            const out = dest.stream.getAudioTracks()[0];
            if (out) mixedAudioTrack = out;
        }

        // --- E) Tạo stream cho MediaRecorder ---
        const finalStream = new MediaStream([...videoTracks, ...(mixedAudioTrack ? [mixedAudioTrack] : [])]);

        // --- F) Ghi ---
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
            ? 'video/webm;codecs=vp9,opus'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm';

        this.recordedBlobs = [];
        this.recorder = new MediaRecorder(finalStream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
        this.recorder.ondataavailable = (e) => {
            if (e.data?.size) this.recordedBlobs.push(e.data);
        };
        this.recorder.onstop = () => {
            const blob = new Blob(this.recordedBlobs, { type: this.recorder?.mimeType || 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `record-${preset}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        };

        this.recorder.start(500);
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
