// Phase ζ.0 spike — PowerInfer JNI stub.
//
// This file is a deliberately empty JNI surface mirroring `llama_jni.cpp`'s
// shape (loadModel/generate/cancel/release/tokenCount). It exists ONLY so
// the link step of `libpowerinfer.so` has at least one Ghola-authored TU to
// compile + link against. The actual PowerInfer dispatch wiring is ζ.3
// work — gated on ζ.0 returning GO.
//
// Implementations return safe defaults (false / "" / 0). Calling these from
// Kotlin should produce no work; Kotlin must not route real generation
// requests here until ζ.3 lands.

#include <jni.h>
#include <android/log.h>
#include <string>

#define PI_TAG "PowerInferStub"
#define PI_LOGI(...) __android_log_print(ANDROID_LOG_INFO,  PI_TAG, __VA_ARGS__)
#define PI_LOGW(...) __android_log_print(ANDROID_LOG_WARN,  PI_TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jboolean JNICALL
Java_xyz_ghola_app_ai_powerinfer_PowerInferNative_loadModel(
    JNIEnv * /* env */, jobject /* this */,
    jstring /* modelPath */, jint /* contextSize */, jint /* numThreads */,
    jfloat /* temp */, jfloat /* topP */) {
    PI_LOGW("loadModel: ζ.0 stub — returning false");
    return JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_xyz_ghola_app_ai_powerinfer_PowerInferNative_generate(
    JNIEnv *env, jobject /* this */,
    jstring /* prompt */, jint /* maxTokens */) {
    PI_LOGW("generate: ζ.0 stub — returning empty string");
    return env->NewStringUTF("");
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_powerinfer_PowerInferNative_cancel(
    JNIEnv * /* env */, jobject /* this */) {
    PI_LOGI("cancel: ζ.0 stub");
}

JNIEXPORT void JNICALL
Java_xyz_ghola_app_ai_powerinfer_PowerInferNative_release(
    JNIEnv * /* env */, jobject /* this */) {
    PI_LOGI("release: ζ.0 stub");
}

JNIEXPORT jint JNICALL
Java_xyz_ghola_app_ai_powerinfer_PowerInferNative_tokenCount(
    JNIEnv * /* env */, jobject /* this */,
    jstring /* text */) {
    return 0;
}

} // extern "C"
