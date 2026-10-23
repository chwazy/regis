# Génère tests/fixtures/audio/fr-phrase.wav (16 kHz, mono, PCM 16 bits) avec la synthèse
# vocale Windows (voix française OneCore, ex. Microsoft Hortense / Julie / Guillaume).
# Usage : powershell -NoProfile -File scripts/capture/make-audio-fixture.ps1
$ErrorActionPreference = 'Stop'

$phrase = 'Bonjour, ceci est un test de transcription de Régis.'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outputDir = Join-Path $root 'tests\fixtures\audio'
$output = Join-Path $outputDir 'fr-phrase.wav'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1

function Wait-WinRt($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait() | Out-Null
    return $task.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$french = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
    Where-Object { $_.Language -like 'fr*' } | Select-Object -First 1
if (-not $french) {
    throw 'Aucune voix française installée (Paramètres > Heure et langue > Voix).'
}
$synth.Voice = $french

$stream = Wait-WinRt ($synth.SynthesizeTextToStreamAsync($phrase)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$reader = New-Object Windows.Storage.Streams.DataReader($stream)
[void](Wait-WinRt ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
$bytes = New-Object byte[] ([int]$stream.Size)
$reader.ReadBytes($bytes)

Add-Type -TypeDefinition @'
using System;
using System.IO;

public static class WavTo16kMono
{
    public static byte[] Convert(byte[] wav)
    {
        int channels = BitConverter.ToInt16(wav, 22);
        int rate = BitConverter.ToInt32(wav, 24);
        int bits = BitConverter.ToInt16(wav, 34);
        if (bits != 16) throw new InvalidDataException("PCM 16 bits attendu");
        int offset = 12;
        int dataStart = -1, dataLength = 0;
        while (offset + 8 <= wav.Length)
        {
            string id = System.Text.Encoding.ASCII.GetString(wav, offset, 4);
            int size = BitConverter.ToInt32(wav, offset + 4);
            if (id == "data") { dataStart = offset + 8; dataLength = Math.Min(size, wav.Length - dataStart); break; }
            offset += 8 + size;
        }
        if (dataStart < 0) throw new InvalidDataException("chunk data introuvable");
        int frames = dataLength / (2 * channels);
        double[] mono = new double[frames];
        for (int i = 0; i < frames; i++)
        {
            double sum = 0;
            for (int c = 0; c < channels; c++) sum += BitConverter.ToInt16(wav, dataStart + (i * channels + c) * 2);
            mono[i] = sum / channels / 32768.0;
        }
        double ratio = rate / 16000.0;
        int outLength = (int)Math.Floor(frames / ratio);
        short[] output = new short[outLength];
        int half = Math.Max(1, (int)Math.Ceiling(ratio));
        for (int n = 0; n < outLength; n++)
        {
            // Moyenne glissante sur une fenêtre d'une période de sortie : filtre passe-bas simple avant décimation.
            double center = n * ratio;
            int from = Math.Max(0, (int)Math.Floor(center - ratio / 2));
            int to = Math.Min(frames - 1, from + half);
            double sum = 0;
            for (int i = from; i <= to; i++) sum += mono[i];
            double value = sum / (to - from + 1);
            output[n] = (short)Math.Max(-32768, Math.Min(32767, Math.Round(value * 32767)));
        }
        using (MemoryStream ms = new MemoryStream())
        using (BinaryWriter w = new BinaryWriter(ms))
        {
            int dataBytes = outLength * 2;
            w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + dataBytes);
            w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt ")); w.Write(16);
            w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
            w.Write(System.Text.Encoding.ASCII.GetBytes("data")); w.Write(dataBytes);
            foreach (short s in output) w.Write(s);
            return ms.ToArray();
        }
    }
}
'@

[System.IO.File]::WriteAllBytes($output, [WavTo16kMono]::Convert($bytes))
Write-Output "Fixture écrite : $output (voix : $($french.DisplayName))"
