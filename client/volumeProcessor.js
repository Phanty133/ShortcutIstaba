class VolumeProcessor extends AudioWorkletProcessor{
	process(inputs, outputs, parameters){
		const data = inputs[0][0]; // Channel 0 of input 0
		const total = data.reduce((acc, val) => acc + Math.abs(val));
		const rms = Math.sqrt(total / data.length);

		this.port.postMessage(rms * 100);

		return true;
	}
}

registerProcessor("volume-processor", VolumeProcessor);