/**
 * Cotton-Tales emotion classifier settings in the settings panel.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { logger } from '../utils/logger.js';
import { applySettingsSnapshot } from './settings-store.js';

/**
 * Initialize Cotton-Tales emotion classifier integration
 * Shows the section only if Cotton-Tales is installed
 */
export async function initializeCottonTalesIntegration(settings) {
    // Check if Cotton-Tales is installed
    const cottonTalesInstalled = !!extension_settings?.cotton_tales;

    if (cottonTalesInstalled) {
        $('#vecthare_cottontales_section').show();
        logger.debug('VectHare: Cotton-Tales detected, showing emotion classification options');
    } else {
        $('#vecthare_cottontales_section').hide();
        return;
    }

    // Import emotion classifier module
    let emotionClassifier;
    try {
        emotionClassifier = await import('../core/emotion-classifier.js');
    } catch (error) {
        console.error('VectHare: Failed to load emotion classifier module:', error);
        return;
    }

    // Helper to update UI based on method selection
    function updateMethodUI(method) {
        $('#vecthare_classifier_settings').toggle(method === 'classifier');
        $('#vecthare_similarity_settings').toggle(method === 'similarity');

        // Update the display of current embedding source for similarity mode
        if (method === 'similarity') {
            $('#vecthare_similarity_source_display').text(settings.source || 'transformers');
        }
    }

    // Determine initial method from settings
    function getCurrentMethod() {
        if (settings.emotion_classifier_enabled && !settings.emotion_use_similarity) {
            return 'classifier';
        } else if (settings.emotion_use_similarity) {
            return 'similarity';
        }
        return 'disabled';
    }

    // Classification method dropdown
    $('#vecthare_emotion_method')
        .val(getCurrentMethod())
        .on('change', function() {
            const method = $(this).val();

            // Update settings based on method
            if (method === 'disabled') {
                settings.emotion_classifier_enabled = false;
                settings.emotion_use_similarity = false;
                emotionClassifier.updateClassifierSetting('enabled', false);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', false);
            } else if (method === 'classifier') {
                settings.emotion_classifier_enabled = true;
                settings.emotion_use_similarity = false;
                emotionClassifier.updateClassifierSetting('enabled', true);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', false);
            } else if (method === 'similarity') {
                settings.emotion_classifier_enabled = true; // Still enabled, but uses similarity
                settings.emotion_use_similarity = true;
                emotionClassifier.updateClassifierSetting('enabled', true);
                emotionClassifier.updateClassifierSetting('useEmbeddingSimilarity', true);
            }

            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            updateMethodUI(method);
        });

    // Initialize UI for current method
    updateMethodUI(getCurrentMethod());

    // Classifier model selection
    $('#vecthare_emotion_classifier_model')
        .val(settings.emotion_classifier_model || 'SamLowe/roberta-base-go_emotions')
        .on('change', function() {
            const value = $(this).val();

            if (value === 'custom') {
                $('#vecthare_custom_classifier_model').show();
            } else {
                $('#vecthare_custom_classifier_model').hide();
                settings.emotion_classifier_model = value;
                applySettingsSnapshot(settings);
                saveSettingsDebounced();
                emotionClassifier.updateClassifierSetting('model', value);
            }
        });

    // Show custom model input if currently set to custom
    if (settings.emotion_classifier_model &&
        !['SamLowe/roberta-base-go_emotions', 'j-hartmann/emotion-english-distilroberta-base', 'bhadresh-savani/distilbert-base-uncased-emotion'].includes(settings.emotion_classifier_model)) {
        $('#vecthare_emotion_classifier_model').val('custom');
        $('#vecthare_custom_classifier_model').show();
    }

    // Custom model input
    $('#vecthare_emotion_classifier_custom')
        .val(settings.emotion_classifier_custom || '')
        .on('input', function() {
            settings.emotion_classifier_custom = $(this).val();
            settings.emotion_classifier_model = $(this).val();
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            emotionClassifier.updateClassifierSetting('model', $(this).val());
        });

    // Test classifier button
    $('#vecthare_test_classifier').on('click', async function() {
        const $btn = $(this);
        const $result = $('#vecthare_classifier_test_result');

        $btn.addClass('disabled').find('i').removeClass('fa-flask').addClass('fa-spinner fa-spin');
        $result.hide();

        try {
            const testResult = await emotionClassifier.testClassifierModel();

            $result.show();

            if (testResult.error) {
                $result.css('background', 'rgba(239,68,68,0.2)').html(`
                    <div style="color: #ef4444;">
                        <i class="fa-solid fa-times-circle"></i>
                        <b>Error:</b> ${testResult.error}
                    </div>
                `);
            } else if (testResult.isEmotionClassifier) {
                const confidenceColor = testResult.confidence === 'high' ? '#22c55e' : '#eab308';
                $result.css('background', 'rgba(34,197,94,0.2)').html(`
                    <div style="color: #22c55e;">
                        <i class="fa-solid fa-check-circle"></i>
                        <b>Looks like an emotion classifier!</b>
                    </div>
                    <div style="margin-top: 4px; font-size: 0.9em;">
                        <b>Confidence:</b> <span style="color: ${confidenceColor}">${testResult.confidence}</span><br>
                        <b>Sample labels:</b> ${testResult.sampleLabels.join(', ')}
                    </div>
                `);
            } else {
                $result.css('background', 'rgba(234,179,8,0.2)').html(`
                    <div style="color: #eab308;">
                        <i class="fa-solid fa-exclamation-triangle"></i>
                        <b>May not be an emotion classifier</b>
                    </div>
                    <div style="margin-top: 4px; font-size: 0.9em;">
                        Labels don't look like emotions: ${testResult.sampleLabels.join(', ')}<br>
                        Consider using a different model.
                    </div>
                `);
            }
        } catch (error) {
            $result.show().css('background', 'rgba(239,68,68,0.2)').html(`
                <div style="color: #ef4444;">
                    <i class="fa-solid fa-times-circle"></i>
                    <b>Test failed:</b> ${error.message}
                </div>
            `);
        } finally {
            $btn.removeClass('disabled').find('i').removeClass('fa-spinner fa-spin').addClass('fa-flask');
        }
    });
}
