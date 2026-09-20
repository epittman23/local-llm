/**
 * Scales a picked image so it covers a centred 250x250 square and returns it as
 * a webp data URL -- the profile-picture treatment Open WebUI applies to user,
 * model and arena-model images alike. Rejects if the file cannot be read as an image.
 */
export function resizeToDataUrl(file: File, size = 250): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = (event) => {
			const img = new Image();
			img.onerror = () => reject(new Error('Could not read that image.'));
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				const aspectRatio = img.width / img.height;
				const width = aspectRatio > 1 ? size * aspectRatio : size;
				const height = aspectRatio > 1 ? size : size / aspectRatio;
				canvas.getContext('2d')?.drawImage(img, (size - width) / 2, (size - height) / 2, width, height);
				resolve(canvas.toDataURL('image/webp', 0.8));
			};
			img.src = String(event.target?.result);
		};
		reader.readAsDataURL(file);
	});
}

export const ACCEPTED_IMAGE_TYPES = ['image/gif', 'image/webp', 'image/jpeg', 'image/png'];
